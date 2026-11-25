/**
 * A commit as a tar stream with one top-level directory, which is what
 * Infrawrench CI's cloud jobs unpack (`--strip-components=1`). Plain ustar
 * with pax records for names that do not fit, so any tar reads it.
 *
 * It lives here because CI needs it before `@infrawrench/git-ops` has an
 * archive of its own; it reads through an `ObjectReader` and nothing else,
 * so it can move there unchanged.
 */
import {
  GitError,
  type ObjectId,
  type ObjectReader,
  encodeText,
  parseCommit,
  parseTree,
  peelTags,
} from "@infrawrench/git-core";

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(
  name: Uint8Array,
  prefix: Uint8Array,
  mode: number,
  size: number,
  mtime: number,
  type: string,
  link: Uint8Array,
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const text = (value: string, at: number): void => {
    block.set(encodeText(value), at);
  };
  block.set(name, 0);
  text(octal(mode, 8), 100);
  text(octal(0, 8), 108);
  text(octal(0, 8), 116);
  text(octal(size, 12), 124);
  text(octal(mtime, 12), 136);
  text("        ", 148);
  text(type, 156);
  block.set(link, 157);
  text("ustar\0", 257);
  text("00", 263);
  text("root", 265);
  text("root", 297);
  block.set(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  text(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padded(data: Uint8Array): Uint8Array {
  const rest = data.length % BLOCK;
  if (rest === 0) return data;
  const out = new Uint8Array(data.length + BLOCK - rest);
  out.set(data);
  return out;
}

/** A pax record: its own length, a space, `key=value`, a newline. */
function paxRecord(key: string, value: Uint8Array): Uint8Array {
  const body = encodeText(` ${key}=`);
  const base = body.length + value.length + 1;
  let length = base + String(base).length;
  // The length counts its own digits, which can add a digit.
  if (base + String(length).length !== length) length = base + String(length).length;
  const digits = encodeText(String(length));
  const out = new Uint8Array(length);
  out.set(digits, 0);
  out.set(body, digits.length);
  out.set(value, digits.length + body.length);
  out[length - 1] = 0x0a;
  return out;
}

/** The header blocks for one entry: a pax header first when the name or link does not fit ustar. */
function entryHeaders(
  path: Uint8Array,
  mode: number,
  size: number,
  mtime: number,
  type: string,
  link: Uint8Array,
): Uint8Array[] {
  let name = path;
  let prefix: Uint8Array = new Uint8Array(0);
  let fits = path.length <= 100;
  if (!fits) {
    // ustar splits a long path at a slash into a 155-byte prefix and a 100-byte name.
    // Not the last byte: a directory's own trailing slash is not a place to split.
    for (let at = Math.min(path.length - 2, 155); at > 0; at--) {
      if (path[at] === 0x2f && path.length - at - 1 <= 100) {
        prefix = path.subarray(0, at);
        name = path.subarray(at + 1);
        fits = name.length > 0;
        break;
      }
    }
  }
  const out: Uint8Array[] = [];
  if (!fits || link.length > 100) {
    const records: Uint8Array[] = [];
    if (!fits) records.push(paxRecord("path", path));
    if (link.length > 100) records.push(paxRecord("linkpath", link));
    let total = 0;
    for (const record of records) total += record.length;
    const body = new Uint8Array(total);
    let at = 0;
    for (const record of records) {
      body.set(record, at);
      at += record.length;
    }
    out.push(
      header(
        encodeText("pax_header"),
        new Uint8Array(0),
        0o644,
        total,
        mtime,
        "x",
        new Uint8Array(0),
      ),
    );
    out.push(padded(body));
    // Readers that follow pax ignore these; the rest see a truncated name rather than nothing.
    if (!fits) {
      name = path.subarray(0, 100);
      prefix = new Uint8Array(0);
    }
  }
  out.push(header(name, prefix, mode, size, mtime, type, link.subarray(0, 100)));
  return out;
}

/**
 * Yields the tar for the tree of `commit` (or of a tag of one), every path
 * under `prefix/`. Submodules become empty directories.
 */
export async function* tarArchive(
  reader: ObjectReader,
  commit: ObjectId,
  prefix: string,
): AsyncGenerator<Uint8Array, void, void> {
  const peeled = await peelTags(reader, commit);
  if (peeled.type !== "commit") throw new GitError("bad-object", `${commit} is not a commit`);
  const object = await reader.read(peeled.oid);
  if (!object) throw new GitError("missing-object", `commit ${commit} is missing`);
  const parsed = parseCommit(object.data);
  const mtime = parsed.committer.timestamp;
  const root = encodeText(`${prefix}/`);
  yield* entryHeaders(root, 0o755, 0, mtime, "5", new Uint8Array(0));

  const join = (dir: Uint8Array, name: Uint8Array, slash: boolean): Uint8Array => {
    const out = new Uint8Array(dir.length + name.length + (slash ? 1 : 0));
    out.set(dir, 0);
    out.set(name, dir.length);
    if (slash) out[out.length - 1] = 0x2f;
    return out;
  };
  // Depth-first with an explicit stack, in tree order, so the listing reads like the repository.
  const stack: Array<{ dir: Uint8Array; oid: ObjectId }> = [{ dir: root, oid: parsed.tree }];
  while (stack.length > 0) {
    const { dir, oid } = stack.pop()!;
    const tree = await reader.read(oid);
    if (!tree || tree.type !== "tree")
      throw new GitError("missing-object", `tree ${oid} is missing`);
    const subtrees: Array<{ dir: Uint8Array; oid: ObjectId }> = [];
    for (const entry of parseTree(tree.data)) {
      const name = entry.rawName ?? encodeText(entry.name);
      if (entry.mode === "040000") {
        const path = join(dir, name, true);
        yield* entryHeaders(path, 0o755, 0, mtime, "5", new Uint8Array(0));
        subtrees.push({ dir: path, oid: entry.oid });
      } else if (entry.mode === "160000") {
        yield* entryHeaders(join(dir, name, true), 0o755, 0, mtime, "5", new Uint8Array(0));
      } else {
        const blob = await reader.read(entry.oid);
        if (!blob) throw new GitError("missing-object", `blob ${entry.oid} is missing`);
        const path = join(dir, name, false);
        if (entry.mode === "120000") {
          yield* entryHeaders(path, 0o777, 0, mtime, "2", blob.data);
        } else {
          const mode = entry.mode === "100755" ? 0o755 : 0o644;
          yield* entryHeaders(path, mode, blob.data.length, mtime, "0", new Uint8Array(0));
          if (blob.data.length > 0) yield padded(blob.data);
        }
      }
    }
    for (let i = subtrees.length - 1; i >= 0; i--) stack.push(subtrees[i]!);
  }
  yield new Uint8Array(BLOCK * 2);
}
