# `@infrawrench/git-core` notes

What this package is, why it is shaped the way it is, and what the packages built on it need to know. The design every git package shares is in `git/README.md`.

## Layout

One job per file, no dependencies, nothing from `node:*` outside `test/`.

| File                                  | Job                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `types.ts`                            | The shared vocabulary (`ObjectId`, `GitObject`, `ObjectReader`, `Commit`, `Ref`, ...).  |
| `errors.ts`                           | `GitError` with a `code`, thrown for every kind of malformed input.                     |
| `bytes.ts`, `hex.ts`, `stream.ts`     | Byte, text, hex and Web Streams helpers.                                                |
| `sha1.ts`, `crc32.ts`, `adler32.ts`   | Incremental SHA-1 with collision detection, CRC-32 (slicing-by-8), Adler-32.            |
| `sha1dc-ubc.gen.ts`                   | The collision detection's tables and bit-condition check, generated (see "SHA-1").      |
| `zlib.ts`                             | `deflate` / `inflate` over `CompressionStream` / `DecompressionStream`.                 |
| `inflate.ts`                          | A streaming zlib decoder that reports how much input it used.                           |
| `signature.ts`                        | Person lines.                                                                           |
| `object/{hash,loose,commit,tree,tag}` | Object ids, loose objects, parse and serialise.                                         |
| `object/read.ts`                      | Typed reads over an `ObjectReader`.                                                     |
| `pack/entry.ts`                       | Pack header and entry headers.                                                          |
| `pack/reader.ts`                      | `PackParser` (push, streaming) and `readPackEntries`.                                   |
| `pack/indexer.ts`                     | `PackIndexer`: ids, types, sizes, offsets and CRCs of a streamed pack, deltas resolved. |
| `pack/access.ts`                      | Reading entries and objects out of a stored pack by byte range.                         |
| `pack/idx.ts`                         | `.idx` v2 writer and reader.                                                            |
| `pack/writer.ts`                      | `PackWriter`, `writePack` (stream), `buildPack`.                                        |
| `pack/delta.ts`                       | Delta apply and create.                                                                 |
| `pack/lru.ts`                         | The byte-budgeted cache the indexer uses.                                               |
| `pktline.ts`, `sideband.ts`           | pkt-line framing, a pull reader, side-band mux and demux.                               |
| `refs.ts`                             | Ref-name rules, symbolic refs, peeling.                                                 |
| `memory-store.ts`                     | An `ObjectReader` in a Map, for tests and for building a few objects.                   |

## zlib: why there is an inflater written here

A pack is zlib streams laid end to end. Nothing in the format gives a stream's compressed length: the entry header has the inflated size only, so the only way to find the next entry is to inflate this one and see where it stopped. `DecompressionStream` cannot be used for that. It does not report how many input bytes it consumed, it buffers ahead, and at least one runtime rejects a stream with bytes after its end.

The alternatives considered:

- **Bisect with `DecompressionStream`**: feed prefixes until one inflates cleanly. Quadratic for large entries, a stream per attempt, and each is asynchronous, so a pack of 100 000 small objects becomes millions of stream constructions.
- **Find the end by its Adler-32 trailer**: inflate everything that is left and search for where the checksum matches. Needs the inflated output first, which is the thing that cannot be had.
- **A decoder written here that counts its input** (chosen). `Inflater` in `inflate.ts` is a synchronous, resumable state machine: `push(chunk, sink)` takes input in any chunking, hands output to the sink through a sliding 32 KiB window, and once the stream ends returns how many bytes of the last chunk lay past it. The bit buffer never holds a whole unread byte between calls, which is what makes the count exact.

Two properties matter beyond counting:

- **It accepts exactly what zlib accepts.** A stream this decoder took and zlib refused could be stored and later served to a git client that cannot read it. The table builder applies zlib's own rules (over-subscribed sets refused, incomplete sets refused except the single-code case), and `test/inflate.test.ts` fuzzes 23 000 random inputs against `node:zlib` in the dangerous direction: whatever is accepted here, zlib accepts, to the same bytes.
- **It reads past the end of a chunk as zeros and checks afterwards.** A symbol or a dynamic block header is decoded without a bounds check per bit; if it turns out to have used bits that were not there, the state is put back to where it began and the bytes are kept for the next `push`. So an error is only reported when the bytes behind it were real.

An `Inflater` holds about 260 KB (window and two 32K-entry code tables), so they are reused: the pack parser keeps one, `inflateSync` borrows a shared one, and `acquireInflater` / `releaseInflater` pool a few for code that awaits between pushes.

`DecompressionStream` is still what `inflate()` uses, for a stream that is the whole input (a loose object), and `CompressionStream` is the only deflater: there is no compressor written here.

## Reading a stored pack (what the worker needs)

Everything is built around one function type:

```ts
type ReadRange = (offset: number, length: number) => Promise<Uint8Array>;
```

In production it is an R2 range GET. It may return fewer bytes only when the pack ends first.

- **`readPackObjectAt(read, offset, options)`** returns the object stored at an offset, following its delta chain. `resolveBase(oid)` is called for a `ref-delta` (the base may be in another pack; only the repository's object index knows). Without a known length it reads 8 KiB first and at most once more; pass `lengthAt(offset)` (or `length` for the first entry) when the index has entry extents and every entry becomes one read.
- **`readPackEntryAt(read, offset)`** returns one entry undeltified, with its CRC-32 and packed length, for passing stored bytes through unchanged.
- **`cachedRangeReader(read)`** puts a block cache (512 KiB blocks, 8 kept) in front of a reader. Wrap the R2 reader in it for anything that reads many entries.
- **To inflate at an offset in bytes already in hand**: `inflateSync(bytes, { offset, size })` returns `{ data, consumed }`.

## Indexing a pack as it arrives (what `ingestPack` needs)

```ts
const indexer = new PackIndexer({ readRange, bases, onObject });
for await (const chunk of body) {
  await upload.write(chunk); // R2 multipart
  if (indexer.write(chunk) > 0) throw ...; // bytes after the end of the pack
  await indexer.settle();
}
await upload.complete(); // `readRange` must work from here
const result = await indexer.finish();
const idx = writePackIndex(result.objects, result.checksum);
```

`write` is synchronous and never buffers the pack. `finish` verifies the trailer and resolves whatever streaming left.

**Pass one, while streaming.** A whole object is hashed as it inflates. A commit, tree or tag is always kept in memory (they are small and the caller usually wants to look at them); a blob is kept only if it is at most a quarter of the cache budget, otherwise it is hashed and dropped. A delta is resolved on the spot when its base is still in the cache, which for packs git writes is common, because git writes a base before the deltas on it. In this repository's own pack 57% of deltas resolve that way with the default 32 MiB cache; the rest are objects of a megabyte or more whose bases had been evicted.

**Pass two, in `finish`.** What is left is resolved depth-first from the bases, reading entries back through `readRange` (behind `cachedRangeReader`), re-deriving an evicted base from the pack when needed. A `ref-delta` whose base is in the pack but later, or resolved only in this pass, is found through a map from base id to waiting deltas. What still waits after that has no base in the pack: the pack is thin, and each base is read from `bases` (the repository). Their ids come back in `externalBases`.

**A small thin pack needs no range reads at all.** Deltas whose base was not at hand are kept (up to `heldDeltaBytes`, 8 MiB) rather than re-read, so an ordinary push, which is a few `ref-delta`s against objects the repository has, finishes without touching R2 again. `stats.rangeReads` says how many reads a pack took.

**`onObject(object, data)`** is called once per object when its id is known, with the content whenever it was in memory: always for commits, trees and tags, and for every blob except a large one stored whole. That is where a push's objects can be checked and its commits walked without a second read. It is not called in pack order.

**Memory.** Per object the table holds 47 bytes in typed arrays (offset, size, CRC, id, base index, header length, two type bytes) and pass two adds 8 more; a million objects is about 55 MB, which is the practical ceiling inside a 128 MB Durable Object. On top of that: the cache (`cacheBytes`, default 32 MiB), held deltas (8 MiB), the read-ahead blocks (4 MiB), bytes queued for hashing (8 MiB, doubled while WebCrypto holds its copy) and one object in flight. Measured peaks, live heap plus array buffers over the baseline:

| Pack                                                  | Cache  | Peak   |
| ----------------------------------------------------- | ------ | ------ |
| 58 MiB, 84 objects (1 MiB random blobs, 21 deltas)    | 8 MiB  | 10 MiB |
| 76 MiB, 92 742 objects, 4.35 GiB inflated (this repo) | 32 MiB | 47 MiB |

Sampling needs care: V8 frees array buffers on a background sweeper, so `process.memoryUsage().arrayBuffers` right after one `gc()` still counts the dead ones. The tests collect twice with a turn of the event loop between.

**Limits and hostile input.** `maxObjectBytes` (default 32 MiB) bounds anything held whole, since applying a delta needs base and result together and an entry header can claim any size before a byte arrives; a whole blob is streamed and not subject to it. `maxObjects` bounds the table, which otherwise grows towards the header's count rather than trusting it. An entry that inflates past its declared size is refused before it is buffered. Offsets and sizes are doubles, exact to 2^53.

**Hashing.** Every object id is computed by `Sha1` (about 300 MiB/s with its collision detection, "SHA-1" below), as the bytes inflate or once the object is whole. WebCrypto runs at 1.5 to 3 GiB/s and used to take every object of 32 KiB or more that was in memory anyway; it has no collision detection, so it no longer names anything. The machinery for a deferred id is still there (`nativeHashBytes`, `hashQueueBytes`, `settle()`): it computes the same detecting hash in a later turn, the default (`Infinity`) never uses it, and it can go once nothing passes the option. The cost: an object's bytes are hashed at a fifth to a tenth of the old speed for large objects, which matters for packs of large blobs and little for source history, where inflating (250 MiB/s) was already the slower half.

## SHA-1: collision detection

An id is the SHA-1 of an object, and the store trusts it to name one object and no other. Two different files with one SHA-1 can be built on purpose (SHAttered in 2017, a chosen-prefix collision in 2020, for some tens of thousands of dollars of computing). Whoever has such a pair can push the harmless half, have it reviewed, and later get the other half served under the same id from somewhere that does not have the first (a fork, a mirror, a cache). Git refuses such objects with `sha1dc`; so does this package.

`Sha1` (`sha1.ts`) is the detection of Marc Stevens and Dan Shumow ("Speeding up detection of SHA-1 collision attacks using unavoidable attack conditions", USENIX Security 2017), ported from the reference C implementation git vendors (https://github.com/cr-marcstevens/sha1collisiondetection, MIT; the licence is `LICENSE-sha1collisiondetection.txt`). The file's header says how it works. What to know when using it:

- **It is on by default and in every hasher.** `new Sha1()`, `sha1Sync`, `hashObject`, `hashObjectBytes`, `hashObjectSync`, the pack indexer (streamed blobs and whole objects), the pack parser's and writer's trailers, `MemoryObjectStore`. So every way an object gets an id is covered: a pushed pack, a loose object, and objects the server writes (merges, web edits, the first commit), which hash content a person chose. `{ detectCollisions: false }` exists for measuring and for the tests.
- **A collision is a `GitError` with code `sha1-collision`**, thrown from `update` at the block that completes it and from `digest`. The protocol sends a `GitError`'s message to the client, so a push is refused with "SHA-1 collision detected: ..." and nothing of the pack is kept. There is no "safe hash" mode (the reference can instead return a different digest for a colliding file); git does not use it either.
- **`sha1()` is the one function without it**: WebCrypto, one shot, for checksums. Never for an id; its comment says so. `test/sha1dc.test.ts` fails if WebCrypto's SHA-1 is called while ids are computed or a pack is indexed.
- **`sha1dc-ubc.gen.ts` is generated** by `node scripts/gen-sha1dc-ubc.mjs <path to the reference's lib/ubc_check.c>`: the 32 disturbance vectors and the bit-condition check, which the reference itself generates. The script translates rather than retypes (it refuses input it does not fully recognise), and the file is not formatted (`*.gen.ts`). The two things it adds for speed, locals for the words and a return once the mask is zero, change no answer.

How it was checked:

- The public collisions are refused: both SHAttered PDFs and both Shambles messages (`test/fixtures/sha1-collisions.ts` holds the colliding prefixes as hex), whole, in any chunking, with anything after them; and no longer once one bit of a colliding block changes.
- Ordinary input is never refused and hashes to what `node:crypto` says (every existing checksum test now runs with detection on, the monorepo suite hashes 93 000 real objects through it).
- The generated check was compared with the reference's compiled `ubc_check` on a million blocks (random, and near-constant words with a few bits flipped so that many conditions hold): 12 844 non-zero masks, every one of the 32 bits seen, no difference. That comparison needs a C compiler and the reference source, so it is not a test here; rerun it when regenerating.
- No git object that collides is public (the `blob <size>\0` header in front of the content changes every block, which is why the SHAttered PDFs have different ids in git), so the path from the hasher to a refused push is tested by making the hasher refuse one object's bytes.

Cost, same machine and run as the table under "Measured": 388 MiB/s with detection off, **304 MiB/s with it on, 22% less**. Of that, the bit-condition check is about 40 ns a block (a 64-byte block compresses in about 160 ns). About one random block in twenty passes the check for some vector and is recompressed once (about 220 ns), which is the rest. That one-in-twenty is the reference's own rate: the conditions are necessary, not sufficient.

Indexing this repository's pack (76.8 MiB, 94 120 objects, 4.42 GiB of objects, mostly megabyte-sized generated files) now takes **24.5 s where `git index-pack --threads=1` took 16.2 s** in the same run, on a machine busy enough that git's own figure was a third above the one below. Before, with large objects going to WebCrypto, the two were level. So a push of large objects indexes at about half the old speed, 180 MiB/s of object bytes. The figures under "Measured" are from before this change.

## Writing a pack

`writePack(inputs, { count })` returns a `ReadableStream`; `PackWriter` is the same thing by hand. An input is one of:

- `{ type, data }`: a whole object, compressed here.
- `{ type: "ref-delta", base: oid, data: delta }`.
- `{ type: "ofs-delta", base: oidOrOffset, data: delta }`: the base must already be in this pack, named by its offset or by the `oid` it was added with.
- any of the above with `{ compressed, size }` instead of `data`: a zlib stream the caller already has, written as it is. This is the fast path for `packObjects`: read stored entries with `readPackEntryAt` or a `PackParser` and pass their bytes through. A copy of a git pack made this way is byte-identical to the original.

The writer never hashes objects; `oid` is only a label for later `ofs-delta` bases. The count has to be known up front because the pack header carries it.

`createDelta(base, target)` indexes the base in 16-byte blocks by a rolling hash and scans the target one byte at a time, extending each match both ways. It caps copies at 64 KiB per instruction, the most conservative reading of the format, and tries at most 32 candidates per position so that input where every block hashes alike stays linear. It does not choose which object to delta against: that is the caller's policy.

## Object model

- **Round trips are byte-exact** for everything git writes and for the oddities history holds. `Commit` and `Tag` keep every header after the known ones in `extraHeaders`, in order, with continuation lines joined by `\n`. A `Signature` or `TreeEntry` that is not in canonical form carries the original spelling (`raw`, `rawMode`, `rawName`), and serialising uses it only while it still parses to the fields beside it, so a changed field cannot be silently overridden by a stale original.
- **Text that is not UTF-8** (commits written in Latin-1, with or without an `encoding` header) is decoded one character per byte and the object is marked `latin1: true`; serialising writes it back the same way. A consumer that wants to display it transcodes using the `encoding` header.
- **`parseSignature` never throws.** A line with no email or no date becomes a signature with the whole line in `raw`.
- **Not exact**: a commit or tag whose headers run to the end with no blank line, and a header line with no space after its key. Both parse; neither serialises back to the same bytes. Git writes neither.
- **`serializeTree` writes entries in the order given** (that is what makes a parsed tree round-trip); **`buildTree` is for trees made in code**: it validates names, refuses duplicates and sorts in git's order, where a directory sorts as if its name ended in `/`.
- `hashObject` is WebCrypto; `hashObjectSync` is the one for loops over many small objects.

## pkt-line

`PktLineReader` pulls one packet at a time and never reads ahead, because a conversation changes framing partway: receive-pack sends commands as packets and then the pack as raw bytes on the same stream. `reader.rest()` (or `restStream()`) returns everything after the last packet read. `readSection()` reads up to the next flush, delimiter or response-end. A zero-length data packet (`0004`) is valid and distinct from a flush. `demuxSideBand(reader)` yields channel 1 up to the flush, reports channel 2 through a callback, and throws on channel 3; it leaves the reader usable for what follows.

`decodePktLines` is for a buffer that is nothing but packets.

## Refs

`isValidRefName` implements `check_refname_format` from git's `refs.c`, with `allowOneLevel` and `refspecPattern` for the two flags; the test runs about 480 names through `git check-ref-format` in all three modes. `isValidBranchName` adds what `--branch` adds (no leading `-`, not `HEAD`). `resolveRef` follows symbolic refs five deep, as git does, and returns null for an unborn branch.

## Measured

Apple M4, Node 24, single thread, the machine also running other work (figures moved by a third between runs).

| Operation                                      | This package | For scale                 |
| ---------------------------------------------- | ------------ | ------------------------- |
| SHA-1, with collision detection                | 300 MiB/s    | `crypto.subtle` 1.5 GiB/s |
| SHA-1, detection off                           | 390 MiB/s    |                           |
| CRC-32                                         | 1.2 GiB/s    |                           |
| Adler-32                                       | 1.4 GiB/s    |                           |
| Inflate, source text (output)                  | 250 MiB/s    | `node:zlib` 800 MiB/s     |
| Inflate, incompressible (output)               | 1.3 GiB/s    | `node:zlib` 7.5 GiB/s     |
| Inflate, 12 000 streams of ~700 bytes (output) | 98 MiB/s     | `node:zlib` 196 MiB/s     |
| `applyDelta`                                   | 20 GiB/s     |                           |
| `createDelta`, similar inputs                  | 540 MiB/s    |                           |
| `createDelta`, unrelated inputs                | 45 MiB/s     |                           |
| `deflate` (`CompressionStream`, level 6)       | 30 MiB/s     |                           |

Indexing this repository's history (one 76 MiB pack, 92 742 objects, 4.35 GiB inflated, 67 000 deltas), streamed from disk in 64 KiB chunks with real positioned reads for `readRange`: **7.8 s** on a quiet machine and 11.8 s on a busy one, where `git index-pack --threads=1` on the same pack took 11.8 s. That is 555 MiB/s of object bytes, about 12 000 objects a second; about 500 range reads. The resulting `.idx` (2.5 MiB, written in 35 ms) is byte-identical to git's. Reading 1 500 random objects back by offset (65 MiB) took 1.0 s.

`GIT_CORE_BENCH=1 pnpm --filter @infrawrench/git-core test test/bench.test.ts` prints the table; the indexing figures are printed by `test/monorepo.test.ts` on every run.

## Tests

`pnpm --filter @infrawrench/git-core test` (about 80 s, no network). Every interop test builds its repositories in temporary directories with a fixed identity and clock. Where there is no `git` on the path the interop tests skip with a warning (44 of 173) and the rest still run, so a green run in a sandbox without git says less than it looks.

- `checksums`, `inflate`: against `node:crypto` and `node:zlib`, every block type, every chunking, fuzzed.
- `sha1dc`: the published SHA-1 collisions refused, ordinary input not, the vector table, and no id from a hash without detection.
- `objects`: commit, tree and tag round trips, against `git mktree`, `git hash-object`, `git fsck`.
- `pack`: packs from `git repack -adf`, `git gc --aggressive`, `git pack-objects` (REF_DELTA), `--thin`; each indexed under several chunkings, cache sizes and hashing modes and compared with `git verify-pack` and git's `.idx` byte for byte; random access; damage; a 58 MiB pack under a memory bound.
- `writer`: packs and deltas made here go through `git index-pack --strict`, `git fsck --strict` and `git unpack-objects`.
- `pktline`: framing, and a protocol v2 `ls-refs` and `fetch` against a real `git upload-pack`.
- `refs`: against `git check-ref-format`, `git rev-parse` for peeling.
- `monorepo`: a `--no-local` clone of this repository: the whole pack indexed, every commit, tree and tag round-tripped (2 833, 43 064 and 152 of them). Skipped on a checkout with fewer than 200 commits.

## Not done

- No compressor: `deflate` is the platform's. A pack written here costs one `CompressionStream` per object, which is fine in workerd and slow in Node.
- No delta selection (which object to delta against which): `createDelta` makes one delta; choosing pairs belongs with repacking.
- No pack index v1, no multi-pack index, no reverse index, no bitmaps.
- No SHA-256 object format.
- The inflater builds a full lookup table per dynamic block. A two-level table would roughly double the speed on packs of many small objects.
- `PackIndexer` keeps its table in memory; past about a million objects it needs a spill to storage.
- A thin pack is indexed but not completed: `externalBases` names what it leans on, and the stored pack still has `ref-delta`s to objects outside it. Reading them back needs `resolveBase`; serving them to a client that lacks the base needs the base sent too.

## Hostile input, after the security review

`git/SECURITY-REVIEW.md` has the findings; what changed here:

- **`maxObjectBytes` also bounds a delta's own instructions**, before they are inflated and when they are read back. A delta whose instructions were gigabytes of zeros and whose result was tiny used to be held whole.
- **`maxInflatedBytes`** (`PackIndexer`): every entry's declared size, every delta result and every rebuild counts against it, before the bytes are produced. Without it a few megabytes of small deltas on a 32 MiB base are terabytes of work. Default none; the worker passes 8 GiB.
- **`object/fsck.ts`**: what git's `fsck` refuses on receive and a forge has to refuse for the people who clone from it. Trees: `.`, `..`, `.git` in any case and in the HFS+ and NTFS spellings git treats as `.git`, a `/` in a name, two entries with one name, entries out of order, a `.gitmodules` that is a link or not a file. `.gitmodules` content read by git's config rules (names with `..`, urls and paths that start with `-`, an `update` that starts with `!`). Commits and tags: the required headers in order, no NUL. Zero-padded modes and odd author lines are left alone, as git only warns about them and old history has them. `ObjectFsck` is the wrapper for a pack: `note(oid, type, data)` from `onObject`, then `finish(read)`.
- **`inflate(data, { maxSize })`**, and `decodeLooseObject` stops at 64 MiB by default.
- `test/hostile.test.ts` holds these, with a fuzz of the object parsers (every failure is a `GitError`).
