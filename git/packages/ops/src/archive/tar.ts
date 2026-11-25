/**
 * `git archive --format=tar`, byte for byte: the same headers, the same
 * order, the same padding, so a tarball served here has the checksum a
 * local `git archive` of the same commit has. (Git's `export-ignore` and
 * `export-subst` attributes are not read; a repository that uses them
 * archives differently here.)
 */
import {
  type ObjectId,
  type ObjectReader,
  type TreeEntryMode,
  encodeText,
  streamFrom,
} from "@infrawrench/git-core";
import type { Limits } from "../limits";
import { type ObjectCache, cacheOf } from "../objects";

export interface ArchiveOptions {
  /** Prepended to every path. To put everything in a directory it must end in `/` (`project-1.0/`). */
  readonly prefix?: string;
  /** Modification time for every entry, seconds. For a commit, use its committer time, as git does. */
  readonly time?: number;
  /** The commit being archived. It is recorded in the archive so `git get-tar-commit-id` can read it back. */
  readonly commit?: ObjectId;
  readonly limits?: Partial<Limits>;
}

export interface ArchiveEntry {
  /** Path with the prefix applied. A directory's ends in `/`. */
  readonly path: string;
  readonly mode: TreeEntryMode;
  readonly oid: ObjectId;
}

/**
 * The entries of an archive in the order git writes them: the prefix
 * directory, then the tree in tree order with each directory ahead of its
 * contents. A submodule is an empty directory.
 */
export async function* archiveEntries(
  cache: ObjectCache,
  tree: ObjectId,
  prefix: string,
): AsyncGenerator<ArchiveEntry, void, void> {
  if (prefix.endsWith("/")) {
    yield { path: prefix.replace(/\/+$/, "/"), mode: "040000", oid: tree };
  }
  async function* walk(oid: ObjectId, base: string): AsyncGenerator<ArchiveEntry, void, void> {
    for (const entry of await cache.tree(oid)) {
      const path = base + entry.name;
      if (entry.mode === "040000") {
        yield { path: `${path}/`, mode: entry.mode, oid: entry.oid };
        yield* walk(entry.oid, `${path}/`);
      } else if (entry.mode === "160000") {
        yield { path: `${path}/`, mode: entry.mode, oid: entry.oid };
      } else {
        yield { path, mode: entry.mode, oid: entry.oid };
      }
    }
  }
  yield* walk(tree, prefix);
}

const RECORD = 512;
const BLOCK = 10240;
const USTAR_MAX_SIZE = 0o77777777777;
const USTAR_MAX_MTIME = 0o77777777777;

function put(header: Uint8Array, offset: number, length: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? encodeText(text) : text;
  header.set(bytes.subarray(0, length), offset);
}

function octal(value: number, digits: number): string {
  return value.toString(8).padStart(digits, "0");
}

interface HeaderFields {
  readonly name: Uint8Array;
  readonly prefix?: Uint8Array;
  readonly mode: number;
  readonly size: number;
  readonly time: number;
  readonly typeflag: string;
  readonly linkname?: Uint8Array;
}

function ustarHeader(fields: HeaderFields): Uint8Array {
  const header = new Uint8Array(RECORD);
  put(header, 0, 100, fields.name);
  put(header, 100, 8, octal(fields.mode & 0o7777, 7));
  put(header, 108, 8, octal(0, 7));
  put(header, 116, 8, octal(0, 7));
  put(header, 124, 12, octal(fields.size, 11));
  put(header, 136, 12, octal(fields.time, 11));
  header[156] = fields.typeflag.charCodeAt(0);
  if (fields.linkname) put(header, 157, 100, fields.linkname);
  put(header, 257, 6, "ustar");
  put(header, 263, 2, "00");
  put(header, 265, 32, "root");
  put(header, 297, 32, "root");
  put(header, 329, 8, octal(0, 7));
  put(header, 337, 8, octal(0, 7));
  if (fields.prefix) put(header, 345, 155, fields.prefix);
  // The checksum is taken with its own field read as spaces.
  let sum = 8 * 0x20;
  for (let i = 0; i < RECORD; i++) sum += header[i]!;
  put(header, 148, 8, octal(sum, 7));
  return header;
}

/** One pax record: `<length> <key>=<value>\n`, where the length counts itself. */
function paxRecord(key: string, value: Uint8Array): Uint8Array {
  // One digit, the space, the key, `=`, the value and the newline; then a digit more per power of ten.
  let length = 1 + 1 + key.length + 1 + value.length + 1;
  for (let tens = 1; Math.floor(length / 10) >= tens; tens *= 10) length++;
  const head = encodeText(`${length} ${key}=`);
  const out = new Uint8Array(head.length + value.length + 1);
  out.set(head, 0);
  out.set(value, head.length);
  out[out.length - 1] = 0x0a;
  return out;
}

/** How much of a long path goes in the header's prefix field: up to a slash within its 155 bytes. */
function prefixLength(path: Uint8Array): number {
  let i = path.length;
  if (i > 1 && path[i - 1] === 0x2f) i--;
  if (i > 155) i = 155;
  do {
    i--;
  } while (i > 0 && path[i] !== 0x2f);
  return i;
}

/** Bytes cut into tar's 512-byte records, zero-padded. */
function* records(data: Uint8Array): Generator<Uint8Array, void, void> {
  if (data.length === 0) return;
  yield data;
  const over = data.length % RECORD;
  if (over !== 0) yield new Uint8Array(RECORD - over);
}

async function* tarChunks(
  cache: ObjectCache,
  tree: ObjectId,
  options: ArchiveOptions,
): AsyncGenerator<Uint8Array, void, void> {
  let time = options.time ?? Math.floor(Date.now() / 1000);
  let written = 0;
  const emit = function* (chunks: Iterable<Uint8Array>): Generator<Uint8Array, void, void> {
    for (const chunk of chunks) {
      written += chunk.length;
      yield chunk;
    }
  };

  const global: Uint8Array[] = [];
  if (options.commit) global.push(paxRecord("comment", encodeText(options.commit)));
  if (time > USTAR_MAX_MTIME) {
    global.push(paxRecord("mtime", encodeText(String(time))));
    time = USTAR_MAX_MTIME;
  }
  if (global.length > 0) {
    let size = 0;
    for (const record of global) size += record.length;
    const body = new Uint8Array(size);
    let at = 0;
    for (const record of global) {
      body.set(record, at);
      at += record.length;
    }
    yield* emit([
      ustarHeader({
        name: encodeText("pax_global_header"),
        mode: 0o666,
        size,
        time,
        typeflag: "g",
      }),
      ...records(body),
    ]);
  }

  for await (const entry of archiveEntries(cache, tree, options.prefix ?? "")) {
    const path = encodeText(entry.path);
    const directory = entry.mode === "040000" || entry.mode === "160000";
    const symlink = entry.mode === "120000";
    // Git's default umask for archives is 002: files are 664, directories and executables 775.
    const mode = directory ? 0o775 : symlink ? 0o777 : entry.mode === "100755" ? 0o775 : 0o664;
    const data = directory ? null : await cache.blob(entry.oid);
    const extended: Uint8Array[] = [];

    let name = path;
    let prefix: Uint8Array | undefined;
    if (path.length > 100) {
      const cut = prefixLength(path);
      const rest = path.length - cut - 1;
      if (cut > 0 && rest <= 100) {
        prefix = path.subarray(0, cut);
        name = path.subarray(cut + 1);
      } else {
        // No way to split it: the real path goes in a pax header and the entry gets a stand-in name.
        name = encodeText(`${entry.oid}.data`);
        extended.push(paxRecord("path", path));
      }
    }
    let linkname: Uint8Array | undefined;
    if (symlink && data) {
      if (data.length > 100) {
        linkname = encodeText(`see ${entry.oid}.paxheader`);
        extended.push(paxRecord("linkpath", data));
      } else linkname = data;
    }
    let size = !directory && !symlink && data ? data.length : 0;
    if (size > USTAR_MAX_SIZE) {
      extended.push(paxRecord("size", encodeText(String(size))));
      size = 0;
    }

    if (extended.length > 0) {
      let total = 0;
      for (const record of extended) total += record.length;
      const body = new Uint8Array(total);
      let at = 0;
      for (const record of extended) {
        body.set(record, at);
        at += record.length;
      }
      yield* emit([
        ustarHeader({
          name: encodeText(`${entry.oid}.paxheader`),
          mode: 0o666,
          size: total,
          time,
          typeflag: "x",
        }),
        ...records(body),
      ]);
    }
    yield* emit([
      ustarHeader({
        name,
        mode,
        size,
        time,
        typeflag: directory ? "5" : symlink ? "2" : "0",
        ...(prefix ? { prefix } : {}),
        ...(linkname ? { linkname } : {}),
      }),
    ]);
    if (!directory && !symlink && data && data.length > 0) yield* emit(records(data));
  }

  // The end is two zero records, and the whole is padded to tar's 10240-byte block.
  const offset = written % BLOCK;
  const tail = BLOCK - offset;
  yield new Uint8Array(tail);
  if (tail < 2 * RECORD) yield new Uint8Array(BLOCK);
}

/** A tree as a tar stream. Memory is bounded by the largest blob. */
export function tarArchive(
  reader: ObjectReader,
  tree: ObjectId,
  options: ArchiveOptions = {},
): ReadableStream<Uint8Array> {
  return streamFrom(tarChunks(cacheOf(reader, options.limits), tree, options));
}

/** The same archive gzipped. Extracts identically to git's `.tar.gz`; the compressed bytes are the platform's. */
export function tarGzArchive(
  reader: ObjectReader,
  tree: ObjectId,
  options: ArchiveOptions = {},
): ReadableStream<Uint8Array> {
  const gzip = new CompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return tarArchive(reader, tree, options).pipeThrough(gzip);
}
