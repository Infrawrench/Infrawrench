# `@infrawrench/git-ops` notes

What a forge does with objects: history, trees, diffs, merges, blame and archives, over an `ObjectReader` from `@infrawrench/git-core`. The design every git package shares is in `git/README.md`.

## Layout

One job per file. Nothing from `node:*` outside `test/`, no dependencies beyond git-core, nothing written anywhere: every operation reads through an `ObjectReader` and returns data.

| File                       | Job                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `limits.ts`                | Every bound, with its default (`Limits`).                                             |
| `objects.ts`               | `ObjectCache`: the reader with caches in front, a slim commit parse, a raw tree scan. |
| `heap.ts`                  | A binary heap.                                                                        |
| `history/queue.ts`         | The order git walks commits in.                                                       |
| `history/merge-base.ts`    | `mergeBases`, `mergeBase`, `isAncestor`.                                              |
| `history/range.ts`         | `aheadBehind`, and the set behind `base..head`.                                       |
| `history/log.ts`           | `log`, `commitsBetween`.                                                              |
| `tree/path.ts`             | `resolvePath`, `lsTree`.                                                              |
| `tree/last-commits.ts`     | `lastCommitsForEntries`.                                                              |
| `diff/lines.ts`            | Lines over bytes, binary detection, whitespace rules.                                 |
| `diff/xdiff.ts`            | The line diff: Myers and histogram with git's heuristics.                             |
| `diff/hunks.ts`            | Unified hunks with context and section headings.                                      |
| `diff/tree-diff.ts`        | Which paths differ between two trees.                                                 |
| `diff/renames.ts`          | Rename and copy detection.                                                            |
| `diff/diff.ts`             | The structured diff a page renders.                                                   |
| `diff/patch.ts`            | Patch text, `--stat`, mailbox-format patches.                                         |
| `merge/text.ts`            | Three-way merge of text.                                                              |
| `merge/tree.ts`            | Three-way merge of trees.                                                             |
| `merge/sink.ts`            | Where new objects are collected, and editing a tree by path.                          |
| `merge/commit.ts`          | Signatures, message normalisation, commit creation.                                   |
| `merge/strategies.ts`      | Merge commit, squash, rebase, fast-forward detection, criss-cross bases.              |
| `blame.ts`                 | Blame.                                                                                |
| `archive/tar.ts`, `zip.ts` | Streaming archives.                                                                   |

## Using it from the worker

- **Make one `ObjectCache` per request** (`new ObjectCache(reader, limits)`) and pass it wherever an `ObjectReader` is asked for. Every function accepts either; a bare reader gets a private cache for that one call, so a page that calls `log`, `diffCommit` and `lastCommitsForEntries` with a bare reader reads the same commits three times.
- **Nothing here writes.** A merge, squash or rebase returns `objects` and the id the target ref should move to. Write the objects, then move the ref, inside whatever serialises ref changes. `objects` is in dependency order: blobs, then trees with children before parents, then commits oldest first. Writing them in that order (or as one pack, `writePack` takes them as they are) never leaves an object pointing at something not yet stored.
- **`objects` can name something the repository already has**: a merged blob that happens to equal an existing one is not known to exist without asking. Objects equal to the three inputs of each merge are left out; filtering the rest through `has()` before writing is optional.
- **Ref updates are the caller's.** `mergeWithCommit` returning `merged` means "write these, then move `target` from the id you gave me to `commit`"; if the target moved in between, redo the call. `fast-forward` and `up-to-date` carry a commit that already exists and write nothing.
- **A fork's pull request needs one reader over both repositories.** Merge bases and merges read both sides through the same `ObjectReader`.

## Bounds

A Durable Object has 128 MB and a CPU budget per request, so every walk, read and allocation stops somewhere. Defaults (`DEFAULT_LIMITS`), all overridable per call through `limits`:

| Limit                | Default | What happens at the limit                                                                                                                                                    |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxCommits`         | 100 000 | `log` returns `truncated: true` with a correct prefix; merge base, ahead/behind and `isAncestor` throw `GitError("limit")`, because a partial answer would be a wrong one.   |
| `maxTextBytes`       | 1 MiB   | A file over it is not diffed, blamed or merged as text: `tooLarge` on a diff or blame, a `too-large` conflict in a merge.                                                    |
| `maxTextLines`       | 100 000 | As above.                                                                                                                                                                    |
| `maxDiffEntries`     | 10 000  | The list of changed paths stops, `truncated: true`, and renames are not looked for in a cut list.                                                                            |
| `maxDiffFiles`       | 300     | Later files are listed with `skipped: true` and no hunks.                                                                                                                    |
| `maxDiffLines`       | 50 000  | As above, once the rendered hunk lines pass it.                                                                                                                              |
| `renameLimit`        | 400     | Inexact rename detection is skipped when sources times destinations exceeds its square (git's rule; git's own default is 1000). Exact and same-name renames are still found. |
| `maxRenameBytes`     | 1 MiB   | A larger blob is only ever matched as an exact rename.                                                                                                                       |
| `treeCacheBytes`     | 8 MiB   | Raw trees kept by an `ObjectCache`.                                                                                                                                          |
| `commitCacheEntries` | 50 000  | Commit graph nodes kept by an `ObjectCache` (about 200 bytes each).                                                                                                          |

Operations with their own budgets: `lastCommitsForEntries` (`maxCommits` default 500, `maxMillis`), `blame` (`maxCommits` default 10 000, `maxMillis`), `rebaseMerge` (`maxCommits` default 250, refused beyond), `lsTree` (`maxEntries` default 10 000). `maxMillis` is wall time checked between commits, which is the only clock a Worker has.

Memory: a history walk holds a few numbers and a tree id per commit visited, never the commit; a diff holds the two files and one `Int32Array` per side; rename detection holds a fingerprint per candidate (about 8 bytes per line), not the blobs; an archive holds one blob at a time (and for zip, its compressed copy).

**Sizes before reads.** A reader may also implement `size(oid)` (`SizedReader`, `objects.ts`): how big an object is, answered without reading it. Where it does, a blob over `maxTextBytes` is refused before it is read by `diffFile`, `blame` and the text merge of `mergeTrees` (a `too-large` conflict), and a blob over `maxRenameBytes` is never read for inexact rename detection. `ObjectCache.size` and `overTextLimit` are the two calls; a reader without `size` behaves as before, the limit enforced after the read, so then the largest blob the repository accepts is the ceiling for a diff or a merge that touches it. The worker's storage answers from the pack entry's header (git-worker's notes, "The reader"). `MemoryObjectStore` has no `size`.

## History

`log` walks in git's order: newest committer date first, and among equal dates the commit queued first. Git keeps a date-sorted list and inserts after equal dates; `DateQueue` is a heap with a sequence number, which is the same order. Commits with equal timestamps are common (rebases, scripted imports) and the tests' histories have them on purpose.

**Path-limited history** uses git's default simplification. A commit is listed when the path (a file or a directory: the entry's id and mode) differs from every parent. A merge that matches a parent is not listed and only the first such parent is followed. This is why a file's history does not show the merges that happened elsewhere, and it is also what makes it fast: whole side branches are never visited. The comparison walks the two trees along the path with a raw scan (`scanTree`) that does not build entries for the names it passes.

**`followRenames`** differs from `git log --follow`, deliberately. Under `--follow` git stops simplifying history altogether (it visits every commit), tracks one name for the whole walk, switching it when it meets a rename, and never lists a merge. Across merges that both loses commits on branches that still had the other name and lists commits whose change a merge threw away. Here following is the path-limited walk above carried on past the rename: the name travels with each line of history, and history is simplified exactly as it is without following. On a straight-line history the output is git's; on a history with merges the two differ, and the tests check what must hold instead (the history under the current name is all there in order, the walk continues under the old names, and every commit listed touches the name it is listed under). Rename sources are looked for among files deleted in the same commit (git also considers unmodified files as copy sources there).

**Merge bases** are git's `paint_down_to_common` and `remove_redundant`, which do not depend on commit dates being sane; a test checks them against brute force on random graphs, including graphs with random dates. `mergeBases` returns them newest first and `mergeBase` returns the first, which is what `git merge-base a b` prints.

**Ahead/behind and `base..head`** (`paintSides`) are exact whenever no commit is older than its own ancestor. Both sides are walked newest first; once nothing one-sided is queued, a common commit only passes its marks on to parents already marked (fixing ones wrongly counted) or no older than the oldest one-sided commit seen. With clocks skewed badly enough that an ancestor is newer than its descendant, a common commit can be counted as one-sided, as it can in git without a commit-graph. A commit-graph with generation numbers would make this exact and much cheaper on large histories; that belongs with storage (a table of generation numbers in the repository's Durable Object, maintained on push), and `paintSides` is the one function that would use it.

`commitsBetween(base, head)` with a path treats every parent alike when deciding whether a commit matches a parent; git gives excluded parents a lesser say. The lists agree except at merges that bring in excluded history.

## Trees

`lastCommitsForEntries` answers "which commit last changed each entry of this directory" for a file table without one history walk per name. The names travel through history together: each commit holds the names still unattributed on its line of history, hands a name to the first parent in which the entry is unchanged, and keeps the names that differ from every parent. A name is held by exactly one commit at a time, so each answer is what `git log -1 -- dir/name` gives. When a directory is identical in a parent, all the names move there without the directory being read.

It is incremental: it stops after `maxCommits` or `maxMillis` and returns what is settled plus a `continuation` (plain data, JSON-safe: commits and the names each holds). Pass the continuation back as `start` to carry on. A client can show the table at once and fill the column in as calls return.

## Diff

**The line diff is a port of git's xdiff**, not a textbook Myers. A shortest edit script is not unique, and git picks a particular one: lines with no match on the other side, and lines with so many matches that they say nothing, are set aside first; a search that gets expensive is cut short by heuristics; and each run of changes is then slid to line up with a change in the other file or, failing that, to where indentation and blank lines say a person would have put it. Hunk boundaries, `--numstat` counts, blame and merge results match git only when all of that is reproduced, so `xdiff.ts` follows `xprepare.c`, `xdiffi.c` and `xhistogram.c` step by step. Both of git's main algorithms are there: `myers` (what `git diff` and `git blame` use) and `histogram` (what `git merge` uses).

**Rename detection is a port of diffcore-rename**: identical content first (no blob is read), then files that kept their basename and are at least 75% alike, then the best remaining pairs at the threshold (50%). Similarity is git's measure (`fingerprint`: the file as chunks ending at a newline or after 64 bytes, hashed, with bytes counted per hash), so the percentages printed are git's. Copies (`-C`) are found when asked for.

**Patch text** is `git diff --full-index` byte for byte: full object ids rather than abbreviations (abbreviating needs to know every object in the repository), git's header lines for mode changes, renames, copies, new and deleted files, type changes (a deletion then a creation), submodules (`Subproject commit <id>`), git's quoting of odd path names and its tab after names with spaces. Two gaps: a binary change is announced (`Binary files a/x and b/x differ`) but not carried, so `git apply` cannot apply it; and with a whitespace option, git prints nothing for a file whose changes all vanish where this still prints the header.

`formatPatch` wraps a commit's diff as a mailbox patch `git am` applies. The header lines and totals match `git format-patch`; the `--stat` layout follows git's but is not promised byte for byte.

Paths are strings. A tree entry whose name is not valid UTF-8 shows with replacement characters in diffs, patches and archives (git-core keeps the original bytes in `rawName`, and trees written by a merge preserve them).

## Merge

**Text** (`mergeText`) is a port of `xmerge.c` at git's default level: changes that do not touch are taken, changes that do are compared, and each conflict is narrowed to the lines that really differ between the two sides, with conflicts three lines or fewer apart joined. Markers follow git's, including CRLF markers in a CRLF file and a newline added after a side that lacks one. `diff3` style and the `ours`/`theirs`/`union` favours are there.

**Trees** (`mergeTrees`) recurse with the same shortcut at every level: a directory only one side changed, or both changed identically, is taken whole without being read. The cost follows what the two sides changed in common.

- Both sides changed a regular file: merged as text against the base (an empty base for add/add). A binary file or one over the text limit is a conflict and the result keeps ours.
- Modes: if only one side changed the mode, that wins; both changing it differently is a `mode` conflict.
- Changed on one side, deleted on the other: `modify-delete`, the changed file stays.
- A file on one side where the other has a directory: the directory keeps the path, the file is in the result as `path~side`.
- Symlinks and submodule pointers changed on both sides: a conflict, ours kept. (Git can fast-forward a submodule pointer when one commit contains the other; that needs the submodule's history, which is another repository.)
- **Renames.** After the first pass, each side's deleted files (those the other side also touched) are matched against the files that side added, with the same detection `diff` uses. A file one side renamed and the other edited becomes one file at the new name carrying both changes. Both renaming to the same name merges against the original. Rename plus delete, and renames to two different names, are conflicts.

With conflicts the result is still a whole tree, holding markers and kept sides as described: that is the tree a "conflicts" view shows, and what a person resolving it starts from. It is not something to commit.

**Not done: directory renames.** Git notices when one side moves a whole directory and the other adds files to the old one, and (by default) reports that as a conflict; here those files simply stay where they were added. Also not done: `.gitattributes` merge drivers and `merge=union`.

**Criss-cross histories** (more than one merge base) are merged against a virtual base, as git's recursive strategy does: the bases are merged with each other first, conflicts between them left in as markers, and that tree stands in as the base. Git folds in a few refinements for conflicts inside the virtual base (it prefers the base's side for binary files and for deletions); here they are merged like any other, which only matters when the bases themselves conflict.

**Strategies** (`mergeWithCommit`, `squashMerge`, `rebaseMerge`) return a `MergeOutcome`: `merged` (objects to write and the new commit), `fast-forward`, `up-to-date`, or `conflicts`. A merge commit has the target as first parent and the source as second. A squash is one commit on the target. A rebase replays the source's commits oldest first, each as a three-way merge of its parent's tree, the new tip's tree and its own; merge commits are left out and a commit whose change the target already has is dropped, as `git rebase` does; it stops at the first commit that conflicts and says which (`stoppedAt`). Replayed commits keep their author and message and lose any signature. By default a commit already sitting on the new base is kept as it is, so a source simply ahead of the target is a fast-forward; `reuseUnchanged: false` rewrites every commit with the new committer, which is what a forge's "rebase and merge" button usually means.

## Blame

Lines start pinned on the commit asked about. Each commit in turn (newest first) diffs its version of the file against each parent's and passes down the lines the parent already had, keeping the ones it added. A file identical in a parent is passed whole without a diff. A file that is new in a commit is looked for under another name in the parent, so blame follows whole-file renames, as `git blame` does by default; moved or copied lines within and between files (`-M`, `-C`) are not followed.

When the budget runs out, the lines still in flight are reported against the commit they had reached with `settled: false`: they are at least that old.

## Archives

`tarArchive` is `git archive --format=tar` byte for byte: the pax global header with the commit id (so `git get-tar-commit-id` reads it back), ustar headers with git's modes (664 files, 775 directories and executables, 777 symlinks), owner `root`, the prefix directory entry, long names split across the prefix field or moved to a pax header, long link targets, submodules as empty directories, and padding to 10 240-byte blocks. Pass the commit's committer time as `time`, as git does. `tarGzArchive` pipes that through `CompressionStream("gzip")`: it gunzips to the same tar, but the compressed bytes are the platform's, not git's.

`zipArchive` is a valid zip with the same entries, Unix modes and symlinks, and the commit id as the archive comment, where git puts it. It is not git's bytes: the compressed data comes from `CompressionStream("deflate-raw")`. Each file is compressed before its header is written, so sizes are in the local header and no data descriptors are needed. Zip64 records are written when a size, an offset or the entry count needs them.

Git's `export-ignore` and `export-subst` attributes are not read; a repository that uses them archives differently here than with `git archive`.

## Parity with git, as tested

Every interop test builds its repositories in temporary directories with a fixed identity and clock, loads all their objects into a `MemoryObjectStore` through `git cat-file --batch`, and compares what this package says with what `git` 2.50 says. Histories are generated: edits, additions, deletions, renames with and without edits, side branches merged back, ties in commit dates.

| What                                            | Compared with                                                                                                   | Result                                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `log`, `--first-parent`                         | `git log --format=%H`                                                                                           | Same commits, same order.                                                                                                                                |
| `log` with a path, every path that ever existed | `git log -- path`                                                                                               | Same commits, same order.                                                                                                                                |
| `log` following renames, linear history         | `git log --follow`                                                                                              | Same.                                                                                                                                                    |
| `log` following renames, with merges            | `git log -- path`, `git show --name-only`                                                                       | Not git's `--follow` by design (see History); invariants.                                                                                                |
| `mergeBases`, `mergeBase`, `isAncestor`         | `git merge-base --all`, `git merge-base`, `--is-ancestor`                                                       | Same, 150 pairs; and brute force on random graphs.                                                                                                       |
| `aheadBehind`                                   | `git rev-list --count --left-right`                                                                             | Same, 150 pairs; and brute force on random graphs.                                                                                                       |
| `commitsBetween`                                | `git log base..head`                                                                                            | Same commits, same order.                                                                                                                                |
| `lsTree`, `resolvePath`                         | `git ls-tree`, `-r`, `-t`                                                                                       | Same.                                                                                                                                                    |
| `lastCommitsForEntries`                         | `git log -1 -- path` per entry                                                                                  | Same, in one call and in steps of 5 commits.                                                                                                             |
| Changed files and statuses                      | `git diff --name-status -M`, `--no-renames`, `-C`                                                               | Same, including similarity scores.                                                                                                                       |
| Line counts                                     | `git diff --numstat`, and with `-w`, `-b`, `--ignore-space-at-eol`                                              | Same.                                                                                                                                                    |
| Patch text                                      | `git diff --full-index -M`, `-U0`, `-U10`, `--inter-hunk-context`, `--histogram`, `--no-indent-heuristic`, `-C` | Byte for byte.                                                                                                                                           |
| Renames, scripted set                           | `git diff --name-status -M`, `-M30%` to `-M100%`, `-l1`                                                         | Same.                                                                                                                                                    |
| `formatPatch`                                   | `git am`; headers and totals of `git format-patch`                                                              | Applies to the same tree; headers and totals the same.                                                                                                   |
| `mergeText`                                     | `git merge-file -p`, both algorithms, `--diff3`, `--ours`, `--theirs`, `--union`                                | Byte for byte, 160 random three-way inputs, same conflict counts.                                                                                        |
| `mergeCommits`                                  | `git merge-tree --write-tree` (`merge.directoryRenames=false`)                                                  | 120 random branch pairs: every clean merge gives the same tree id; every conflicted one lists the same paths, and most of those trees are identical too. |
| Merge commit, squash                            | `git merge --no-ff`, `git merge --squash`                                                                       | Same tree; objects pass `git fsck --strict`.                                                                                                             |
| Rebase                                          | `git rebase`                                                                                                    | Same trees, authors and messages commit for commit.                                                                                                      |
| `blame`                                         | `git blame --porcelain`                                                                                         | Same commit, original line and original path for every line of every file, at four revisions.                                                            |
| `tarArchive`                                    | `git archive --format=tar`, five prefixes, commit and tree                                                      | Byte for byte.                                                                                                                                           |
| `tarGzArchive`                                  | gunzip, then the tar above                                                                                      | Same tar.                                                                                                                                                |
| `zipArchive`, with and without zip64            | `unzip`, against the extracted `git archive`                                                                    | Same files, modes and symlinks.                                                                                                                          |

Where there is no `git` on the path the interop suites skip with a warning; `unit.test.ts` and the diff half of `perf.test.ts` need nothing and still run.

## Measured

Apple M4, Node 24, single thread, objects in memory, on a machine doing other work. `test/perf.test.ts` asserts each against a budget several times larger.

| Operation                                                | Time   | Budget in the test |
| -------------------------------------------------------- | ------ | ------------------ |
| Diff, 10 000 lines, 300 edits, Myers                     | 26 ms  | 250 ms             |
| Diff, 10 000 lines, 300 edits, histogram                 | 21 ms  | 250 ms             |
| Diff, 10 000 lines against 10 000 unrelated lines        | 16 ms  | 250 ms             |
| Diff, 10 000 very repetitive lines                       | 65 ms  | 750 ms             |
| Three-way merge, 10 000 lines, 300 edits a side          | 38 ms  | 500 ms             |
| `log`, all of 5 000 commits                              | 51 ms  | 1 000 ms           |
| `log` for one file over 5 000 commits (all visited)      | 55 ms  | 1 000 ms           |
| `log`, first 30 commits for a directory                  | 1.3 ms | 100 ms             |
| `aheadBehind` across 4 000 commits                       | 14 ms  | 750 ms             |
| Merge base with a branch 4 750 commits back              | 53 ms  | 750 ms             |
| `lastCommitsForEntries`, a directory of 8 files          | 1.2 ms | 750 ms             |
| `blame` of a file through 5 000 commits (4 290 examined) | 45 ms  | 1 000 ms           |

These are CPU figures with every object already in memory. In the worker, an object read is a lookup in the repository's index and, for a miss, a range read from R2, and that dominates: walking 5 000 commits is 5 000 commit reads plus the trees along one path.

**The commit graph is the caller's to keep.** `new ObjectCache(reader, limits, { graph })` takes a `CommitGraphSource` (`get(oid)`, `set(node)`): `ObjectCache.node` reads through it and fills it, and then holds no nodes of its own (`commitCacheEntries` does not apply; the source bounds itself). One source shared by every request's cache takes the commit reads out of every walk after the first. The worker keeps one per Durable Object, in memory.

**`lastCommitsForEntries` takes answers the caller already has** (`known(commit)`): a finished answer for the same directory at an older commit. A walk that reaches such a commit settles every name it still holds from that answer and goes no further down that line. It is exact, because a name is only ever handed to a commit in which its entry is unchanged, so what the older answer says of the name is what the walk would have found. With the answer for yesterday's head kept, today's file table costs the commits pushed since.

## Tests

`pnpm --filter @infrawrench/git-ops test` (about three minutes, most of it `git` building fixture repositories; no network).

## Not done

- No generation numbers (see History). A commit graph can be plugged in (`CommitGraphSource`), but `paintSides` still orders by commit date.
- Directory rename detection in merges; merge drivers and attributes of any kind.
- Blame `-M`/`-C` (moved and copied lines), `-L` ranges, ignoring revisions.
- Binary patches (`git diff --binary`); word diffs; function-context hunks (`-W`); per-language section headings (git's `diff=` drivers; the default heading rule is implemented).
- `export-ignore`/`export-subst` in archives.
- Octopus merges.
- Sizes are asked before reads only of a reader that has `size` (see Bounds); binary detection still needs the read.
