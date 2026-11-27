import { decodeLatin1, decodeText, decodeTextStrict, encodeText } from "../bytes";
import { GitError } from "../errors";
import { isObjectId, toHex, writeHex } from "../hex";
import type { TreeEntry, TreeEntryMode } from "../types";

/** How git writes each mode into a tree: no leading zero on a directory. */
const WRITTEN: Record<TreeEntryMode, string> = {
  "040000": "40000",
  "100644": "100644",
  "100755": "100755",
  "120000": "120000",
  "160000": "160000",
};

/**
 * The mode a stored mode string means, or null when it is not a mode git
 * knows. Old trees hold `100664` and `100600`, and some tools pad `40000`
 * with a zero; all of them still mean one of the five.
 */
export function normalizeTreeMode(text: string): TreeEntryMode | null {
  if (!/^[0-7]{1,7}$/.test(text)) return null;
  const mode = Number.parseInt(text, 8);
  switch (mode & 0o170000) {
    case 0o040000:
      return "040000";
    case 0o100000:
      return mode & 0o111 ? "100755" : "100644";
    case 0o120000:
      return "120000";
    case 0o160000:
      return "160000";
    default:
      return null;
  }
}

export function isTreeMode(mode: TreeEntryMode): boolean {
  return mode === "040000";
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    // A mode is at most seven digits; looking further means the entry is damaged.
    if (space < 0 || space - position > 7)
      throw new GitError("bad-object", "tree entry has no mode");
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 20 > data.length)
      throw new GitError("bad-object", "tree entry is cut short");
    const modeText = decodeLatin1(data.subarray(position, space));
    const mode = normalizeTreeMode(modeText);
    if (mode === null) throw new GitError("bad-object", `tree entry has the mode ${modeText}`);
    const nameBytes = data.subarray(space + 1, nul);
    if (nameBytes.length === 0) throw new GitError("bad-object", "tree entry has an empty name");
    const strict = decodeTextStrict(nameBytes);
    const entry: {
      mode: TreeEntryMode;
      name: string;
      oid: string;
      rawMode?: string;
      rawName?: Uint8Array;
    } = {
      mode,
      name: strict ?? decodeText(nameBytes),
      oid: toHex(data, nul + 1, nul + 21),
    };
    if (modeText !== WRITTEN[mode]) entry.rawMode = modeText;
    if (strict === null) entry.rawName = nameBytes.slice();
    entries.push(entry);
    position = nul + 21;
  }
  return entries;
}

function entryNameBytes(entry: TreeEntry): Uint8Array {
  if (entry.rawName !== undefined && decodeText(entry.rawName) === entry.name) return entry.rawName;
  return encodeText(entry.name);
}

function entryModeText(entry: TreeEntry): string {
  if (entry.rawMode !== undefined && normalizeTreeMode(entry.rawMode) === entry.mode) {
    return entry.rawMode;
  }
  return WRITTEN[entry.mode];
}

/**
 * Writes the entries in the order given, which is what makes a parsed tree
 * come back byte for byte. A tree being built from scratch goes through
 * `buildTree`, which sorts and checks it.
 */
export function serializeTree(entries: readonly TreeEntry[]): Uint8Array {
  const parts: Array<{ mode: Uint8Array; name: Uint8Array; oid: string }> = [];
  let size = 0;
  for (const entry of entries) {
    if (!isObjectId(entry.oid)) throw new GitError("bad-object", "tree entry has a malformed id");
    const mode = encodeText(entryModeText(entry));
    const name = entryNameBytes(entry);
    parts.push({ mode, name, oid: entry.oid });
    size += mode.length + 1 + name.length + 1 + 20;
  }
  const out = new Uint8Array(size);
  let position = 0;
  for (const part of parts) {
    out.set(part.mode, position);
    position += part.mode.length;
    out[position++] = 0x20;
    out.set(part.name, position);
    position += part.name.length;
    out[position++] = 0;
    writeHex(part.oid, out, position);
    position += 20;
  }
  return out;
}

function compareNames(a: Uint8Array, aIsTree: boolean, b: Uint8Array, bIsTree: boolean): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  // Git orders a directory as though its name ended in "/", so `a.b` sorts before `a/` before `a0`.
  const nextA = a.length > shared ? a[shared]! : aIsTree ? 0x2f : 0;
  const nextB = b.length > shared ? b[shared]! : bIsTree ? 0x2f : 0;
  return nextA - nextB;
}

/** The order entries have inside a tree object. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  return compareNames(entryNameBytes(a), isTreeMode(a.mode), entryNameBytes(b), isTreeMode(b.mode));
}

export function sortTreeEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  const keyed = entries.map((entry) => ({ entry, name: entryNameBytes(entry) }));
  keyed.sort((a, b) =>
    compareNames(a.name, isTreeMode(a.entry.mode), b.name, isTreeMode(b.entry.mode)),
  );
  return keyed.map((item) => item.entry);
}

/** True for a name git will take as one path component of a tree. */
export function isValidTreeEntryName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\0")) return false;
  // `.git` in any case would let a checkout write into the repository's own directory.
  return name.toLowerCase() !== ".git";
}

/**
 * Serialises a tree made in code: checks every name, refuses duplicates, and
 * sorts. A file and a directory cannot share a name either, which sorting
 * alone would not catch because the two sort apart.
 */
export function buildTree(entries: readonly TreeEntry[]): Uint8Array {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isValidTreeEntryName(entry.name)) {
      throw new GitError(
        "bad-object",
        `not a valid tree entry name: ${JSON.stringify(entry.name)}`,
      );
    }
    if (seen.has(entry.name)) {
      throw new GitError("bad-object", `tree has two entries named ${JSON.stringify(entry.name)}`);
    }
    seen.add(entry.name);
  }
  return serializeTree(sortTreeEntries(entries));
}

/** The entry with this name, or null. */
export function findTreeEntry(entries: readonly TreeEntry[], name: string): TreeEntry | null {
  for (const entry of entries) if (entry.name === name) return entry;
  return null;
}

/** True when the entries are in the order git requires. */
export function isSortedTree(entries: readonly TreeEntry[]): boolean {
  for (let i = 1; i < entries.length; i++) {
    if (compareTreeEntries(entries[i - 1]!, entries[i]!) >= 0) return false;
  }
  return true;
}
