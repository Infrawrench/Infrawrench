/**
 * A tree as a zip stream. Unlike the tar, this is not git's bytes: the
 * compressor is the platform's `CompressionStream`, so the same archive
 * made by `git archive` differs in its compressed data. It extracts to the
 * same files, with the same modes and symlinks, and carries the commit id
 * as the archive comment, where git puts it.
 */
import {
  type ObjectId,
  type ObjectReader,
  collectBytes,
  crc32,
  encodeText,
  streamFrom,
  streamOf,
} from "@infrawrench/git-core";
import { type ObjectCache, cacheOf } from "../objects";
import { type ArchiveOptions, archiveEntries } from "./tar";

export interface ZipOptions extends ArchiveOptions {
  /** Write zip64 records even when nothing needs them. For tests; readers accept both. */
  readonly forceZip64?: boolean;
}

const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;

class Writer {
  private readonly view: DataView;
  private at = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u16(value: number): this {
    this.view.setUint16(this.at, value, true);
    this.at += 2;
    return this;
  }

  u32(value: number): this {
    this.view.setUint32(this.at, value >>> 0, true);
    this.at += 4;
    return this;
  }

  u64(value: number): this {
    // Sizes and offsets are doubles, exact to 2^53, which is far past anything a Worker streams.
    this.u32(value % 0x100000000);
    return this.u32(Math.floor(value / 0x100000000));
  }

  raw(data: Uint8Array): this {
    this.bytes.set(data, this.at);
    this.at += data.length;
    return this;
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  return collectBytes(streamOf(data).pipeThrough(stream));
}

/** A moment as the two 16-bit fields zip keeps, which have no time zone; UTC is used. */
function dosDateTime(seconds: number): { date: number; time: number } {
  const d = new Date(seconds * 1000);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

interface Central {
  readonly name: Uint8Array;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
  readonly attributes: number;
  readonly zip64: boolean;
}

async function* zipChunks(
  cache: ObjectCache,
  tree: ObjectId,
  options: ZipOptions,
): AsyncGenerator<Uint8Array, void, void> {
  const stamp = dosDateTime(options.time ?? Math.floor(Date.now() / 1000));
  const force = options.forceZip64 === true;
  const central: Central[] = [];
  let offset = 0;

  for await (const entry of archiveEntries(cache, tree, options.prefix ?? "")) {
    const name = encodeText(entry.path);
    const directory = entry.mode === "040000" || entry.mode === "160000";
    const data = directory ? new Uint8Array(0) : await cache.blob(entry.oid);
    let body = data;
    let method = 0;
    // A symlink's target is stored, never deflated, which is what unzip expects to read back.
    if (!directory && entry.mode !== "120000" && data.length > 0) {
      const deflated = await deflateRaw(data);
      if (deflated.length < data.length) {
        body = deflated;
        method = 8;
      }
    }
    const crc = crc32(data);
    const unixMode = directory
      ? 0o040755
      : entry.mode === "120000"
        ? 0o120777
        : entry.mode === "100755"
          ? 0o100755
          : 0o100644;
    const zip64 = force || data.length >= MAX_32 || body.length >= MAX_32;
    const extra = zip64 ? 20 : 0;
    const local = new Writer(new Uint8Array(30 + name.length + extra));
    local
      .u32(0x04034b50)
      .u16(zip64 ? 45 : method === 8 ? 20 : 10)
      .u16(0x0800) // names are UTF-8
      .u16(method)
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(crc)
      .u32(zip64 ? MAX_32 : body.length)
      .u32(zip64 ? MAX_32 : data.length)
      .u16(name.length)
      .u16(extra)
      .raw(name);
    if (zip64) local.u16(0x0001).u16(16).u64(data.length).u64(body.length);
    yield local.bytes;
    if (body.length > 0) yield body;
    central.push({
      name,
      method,
      crc,
      compressed: body.length,
      size: data.length,
      offset,
      // The high half is the Unix mode; the low byte's 0x10 is the DOS directory bit.
      attributes: ((unixMode << 16) | (directory ? 0x10 : 0)) >>> 0,
      zip64: zip64 || offset >= MAX_32,
    });
    offset += local.bytes.length + body.length;
  }

  const directoryStart = offset;
  for (const item of central) {
    const extra = item.zip64 ? 28 : 0;
    const record = new Writer(new Uint8Array(46 + item.name.length + extra));
    record
      .u32(0x02014b50)
      .u16((3 << 8) | (item.zip64 ? 45 : 20)) // made on Unix, so the mode above is honoured
      .u16(item.zip64 ? 45 : item.method === 8 ? 20 : 10)
      .u16(0x0800)
      .u16(item.method)
      .u16(stamp.time)
      .u16(stamp.date)
      .u32(item.crc)
      .u32(item.zip64 ? MAX_32 : item.compressed)
      .u32(item.zip64 ? MAX_32 : item.size)
      .u16(item.name.length)
      .u16(extra)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(item.attributes)
      .u32(item.zip64 ? MAX_32 : item.offset)
      .raw(item.name);
    if (item.zip64) record.u16(0x0001).u16(24).u64(item.size).u64(item.compressed).u64(item.offset);
    yield record.bytes;
    offset += record.bytes.length;
  }
  const directorySize = offset - directoryStart;

  const needs64 =
    force || central.length >= MAX_16 || directoryStart >= MAX_32 || directorySize >= MAX_32;
  if (needs64) {
    const end64 = new Writer(new Uint8Array(56 + 20));
    end64
      .u32(0x06064b50)
      .u64(44)
      .u16((3 << 8) | 45)
      .u16(45)
      .u32(0)
      .u32(0)
      .u64(central.length)
      .u64(central.length)
      .u64(directorySize)
      .u64(directoryStart)
      .u32(0x07064b50)
      .u32(0)
      .u64(offset)
      .u32(1);
    yield end64.bytes;
  }
  const comment = encodeText(options.commit ?? "");
  const end = new Writer(new Uint8Array(22 + comment.length));
  end
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(needs64 ? MAX_16 : central.length)
    .u16(needs64 ? MAX_16 : central.length)
    .u32(needs64 ? MAX_32 : directorySize)
    .u32(needs64 ? MAX_32 : directoryStart)
    .u16(comment.length)
    .raw(comment);
  yield end.bytes;
}

/** A tree as a zip stream. Memory is bounded by the largest blob and its compressed copy. */
export function zipArchive(
  reader: ObjectReader,
  tree: ObjectId,
  options: ZipOptions = {},
): ReadableStream<Uint8Array> {
  return streamFrom(zipChunks(cacheOf(reader, options.limits), tree, options));
}
