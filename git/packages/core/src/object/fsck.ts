/**
 * What a forge refuses on push so that a clone of it cannot hurt the person
 * making it: the checks of git's `fsck` that `receive.fsckObjects` turns
 * into errors and that protect a checkout, not the ones about style.
 *
 * - Trees: no entry named `.`, `..`, `.git` (in any case, or in a spelling
 *   that HFS+ or NTFS treats as `.git`), no `/` in a name, no two entries
 *   with one name, entries in git's order, no `.gitmodules` that is a
 *   symbolic link or not a file, no `.gitattributes` that is not a file.
 * - `.gitmodules` files: no submodule name that climbs out with `..`, no
 *   `url` or `path` that reads as a command-line option, no `url` with a
 *   newline once percent-decoded or that climbs past its root, no `update`
 *   that runs a command.
 * - `.gitattributes` files: at most 100 MiB, no line of 2048 bytes or more.
 * - Commits and tags: the headers git requires, in order, and no NUL among them.
 *
 * Zero-padded modes, odd idents and the rest of what git only warns about
 * are left alone: they are common in old history and hurt nobody.
 *
 * `ObjectFsck` checks a pack as it is indexed: `note` each object, then
 * `finish` with a reader for the special files that did not pass by with
 * their content. Everything refused is a `GitError` with code `bad-object`.
 */
import { decodeLatin1, encodeText } from "../bytes";
import { GitError } from "../errors";
import type { ObjectId, ObjectType, TreeEntry } from "../types";
import { parseCommit } from "./commit";
import { parseTag } from "./tag";
import { compareTreeEntries, parseTree } from "./tree";

/** git's `ATTR_MAX_FILE_SIZE`. */
export const MAX_GITATTRIBUTES_BYTES = 100 * 1024 * 1024;
/** git's `ATTR_MAX_LINE_LENGTH`: a line this long or longer is refused. */
export const MAX_GITATTRIBUTES_LINE = 2048;

function refuse(message: string): GitError {
  return new GitError("bad-object", message);
}

// Names, as bytes.

const lower = (byte: number): number => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);

/** Whether `name` starts at `at` with the ASCII `needle`, ignoring case. */
function startsWithFolded(name: Uint8Array, at: number, needle: string): boolean {
  if (name.length - at < needle.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (lower(name[at + i]!) !== needle.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The next code point of UTF-8 `name` at `state.at`, or -1 where it is not
 * well-formed. Malformed input ends the name as far as HFS+ goes, as in git.
 */
function nextCodePoint(name: Uint8Array, state: { at: number }): number {
  const first = name[state.at];
  if (first === undefined) return 0;
  if (first < 0x80) {
    state.at++;
    return first;
  }
  let length: number;
  if (first >= 0xc2 && first <= 0xdf) length = 2;
  else if (first >= 0xe0 && first <= 0xef) length = 3;
  else if (first >= 0xf0 && first <= 0xf4) length = 4;
  else return -1;
  let point = first & (0xff >> (length + 1));
  for (let i = 1; i < length; i++) {
    const byte = name[state.at + i];
    if (byte === undefined || (byte & 0xc0) !== 0x80) return -1;
    point = (point << 6) | (byte & 0x3f);
  }
  const minimum = length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
  if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return -1;
  state.at += length;
  return point;
}

/** Code points HFS+ drops when it compares names (git's `next_hfs_char`). */
function hfsIgnored(point: number): boolean {
  return (
    (point >= 0x200c && point <= 0x200f) ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x206a && point <= 0x206f) ||
    point === 0xfeff
  );
}

function nextHfsChar(name: Uint8Array, state: { at: number }): number {
  for (;;) {
    const point = nextCodePoint(name, state);
    if (point < 0) return 0;
    if (!hfsIgnored(point)) return point;
  }
}

/** Whether HFS+ would treat `name` as `.<needle>` (git's `is_hfs_dot_generic`). */
export function isHfsDot(name: Uint8Array, needle: string): boolean {
  const state = { at: 0 };
  if (nextHfsChar(name, state) !== 0x2e) return false;
  for (let i = 0; i < needle.length; i++) {
    const point = nextHfsChar(name, state);
    if (point > 127 || lower(point) !== needle.charCodeAt(i)) return false;
  }
  const after = nextHfsChar(name, state);
  return after === 0 || after === 0x2f;
}

/** From `at` on, only spaces and dots until the end or a `:` (git's `only_spaces_and_periods`). */
function onlySpacesAndPeriods(name: Uint8Array, at: number, separators: boolean): boolean {
  for (let i = at; ; i++) {
    const byte = name[i];
    if (byte === undefined || byte === 0x3a) return true;
    if (separators && (byte === 0x2f || byte === 0x5c)) return true;
    if (byte !== 0x20 && byte !== 0x2e) return false;
  }
}

/** Whether NTFS would treat `name` as `.git` (git's `is_ntfs_dotgit`). */
export function isNtfsDotGit(name: Uint8Array): boolean {
  if (name[0] === 0x2e && startsWithFolded(name, 1, "git")) {
    return onlySpacesAndPeriods(name, 4, true);
  }
  if (startsWithFolded(name, 0, "git~1")) return onlySpacesAndPeriods(name, 5, true);
  return false;
}

/**
 * Whether NTFS would treat `name` as `.<needle>`, short names included
 * (git's `is_ntfs_dot_generic`). `shortPrefix` is the six characters NTFS
 * uses when it shortens the name by hash.
 */
export function isNtfsDot(name: Uint8Array, needle: string, shortPrefix: string): boolean {
  if (name[0] === 0x2e && startsWithFolded(name, 1, needle)) {
    return onlySpacesAndPeriods(name, needle.length + 1, false);
  }
  if (
    startsWithFolded(name, 0, needle.slice(0, 6)) &&
    name[6] === 0x7e &&
    name[7] !== undefined &&
    name[7] >= 0x31 &&
    name[7] <= 0x34
  ) {
    return onlySpacesAndPeriods(name, 8, false);
  }
  let sawTilde = false;
  let i = 0;
  for (; i < 8; i++) {
    const byte = name[i];
    if (byte === undefined) return false;
    if (sawTilde) {
      if (byte < 0x30 || byte > 0x39) return false;
    } else if (byte === 0x7e) {
      i++;
      const digit = name[i];
      if (digit === undefined || digit < 0x31 || digit > 0x39) return false;
      sawTilde = true;
    } else if (i >= 6 || byte & 0x80 || lower(byte) !== shortPrefix.charCodeAt(i)) {
      return false;
    }
  }
  return onlySpacesAndPeriods(name, i, false);
}

/** `.git` as any file system that matters could read it. */
export function isDotGitName(name: Uint8Array): boolean {
  return (
    (name.length === 4 && startsWithFolded(name, 0, ".git")) ||
    isHfsDot(name, "git") ||
    isNtfsDotGit(name)
  );
}

export function isDotGitmodulesName(name: Uint8Array): boolean {
  return isHfsDot(name, "gitmodules") || isNtfsDot(name, "gitmodules", "gi7eba");
}

export function isDotGitattributesName(name: Uint8Array): boolean {
  return isHfsDot(name, "gitattributes") || isNtfsDot(name, "gitattributes", "gi7d29");
}

// Objects.

/** Blobs a tree names that must be checked as `.gitmodules` or `.gitattributes`. */
export interface TreeFindings {
  readonly gitmodules: ObjectId[];
  readonly gitattributes: ObjectId[];
}

function nameBytes(entry: TreeEntry): Uint8Array {
  return entry.rawName ?? encodeText(entry.name);
}

const shown = (name: Uint8Array): string => JSON.stringify(decodeLatin1(name.subarray(0, 64)));

/** Checks a tree. Throws a `GitError` for anything above; returns the special blobs it names. */
export function fsckTree(data: Uint8Array): TreeFindings {
  const entries = parseTree(data);
  const findings: TreeFindings = { gitmodules: [], gitattributes: [] };
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const name = nameBytes(entry);
    const text = decodeLatin1(name);
    if (text === "." || text === "..") throw refuse(`tree has an entry named ${shown(name)}`);
    if (name.includes(0x2f)) throw refuse(`tree entry ${shown(name)} contains a slash`);
    if (isDotGitName(name)) throw refuse(`tree has an entry named like .git: ${shown(name)}`);
    if (seen.has(text)) throw refuse(`tree has two entries named ${shown(name)}`);
    seen.add(text);
    if (i > 0 && compareTreeEntries(entries[i - 1]!, entry) >= 0) {
      throw refuse("tree entries are not in git's order");
    }
    const file = entry.mode === "100644" || entry.mode === "100755";
    if (isDotGitmodulesName(name)) {
      if (entry.mode === "120000") throw refuse(".gitmodules is a symbolic link");
      if (!file) throw refuse(".gitmodules is not a file");
      findings.gitmodules.push(entry.oid);
    } else if (isDotGitattributesName(name)) {
      if (entry.mode !== "120000") {
        if (!file) throw refuse(".gitattributes is not a file");
        findings.gitattributes.push(entry.oid);
      }
    }
  }
  return findings;
}

/** Where the header block ends: the blank line, or the end of the object. */
function headerEnd(data: Uint8Array): number {
  if (data[0] === 0x0a) return 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i] === 0x0a && data[i - 1] === 0x0a) return i;
  }
  return data.length;
}

function checkHeaders(data: Uint8Array, kind: string): void {
  const end = headerEnd(data);
  if (data.subarray(0, end).includes(0)) throw refuse(`${kind} has a NUL in its headers`);
}

/** Checks a commit: `tree`, `parent`s, `author`, `committer`, in that order, and no NUL among them. */
export function fsckCommit(data: Uint8Array): void {
  checkHeaders(data, "commit");
  parseCommit(data);
}

/** Checks an annotated tag: `object`, `type`, `tag`, and no NUL among them. */
export function fsckTag(data: Uint8Array): void {
  checkHeaders(data, "tag");
  parseTag(data);
}

// `.gitmodules`.

interface ConfigEntry {
  readonly section: string;
  readonly subsection: string | null;
  readonly key: string;
  readonly value: string | null;
}

const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAlpha = (c: string): boolean => /^[A-Za-z]$/.test(c);
const isKeyChar = (c: string): boolean => /^[A-Za-z0-9-]$/.test(c);

/**
 * The entries of a git config file, read by git's own rules (`config.c`),
 * up to the first thing git would refuse to parse. Git stops there too, so
 * whatever follows never reaches a client either.
 */
export function readConfigEntries(data: Uint8Array): ConfigEntry[] {
  // One character per byte: the checks below only look at ASCII.
  let text = decodeLatin1(data);
  if (text.startsWith("\xef\xbb\xbf")) text = text.slice(3);
  text = text.replace(/\r\n/g, "\n");
  const entries: ConfigEntry[] = [];
  let at = 0;
  // Past the end reads as a newline, as git's `get_next_char` does.
  const next = (): string => (at < text.length ? text[at++]! : (at++, "\n"));
  const eof = (): boolean => at >= text.length;
  let section: string | null = null;
  let subsection: string | null = null;

  const readValue = (): string | null => {
    let value = "";
    let quote = false;
    let comment = false;
    let spaces = 0;
    for (;;) {
      const c = next();
      if (c === "\n") return quote ? null : value;
      if (comment) continue;
      if (isSpace(c) && !quote) {
        if (value.length > 0) spaces++;
        continue;
      }
      if (!quote && (c === ";" || c === "#")) {
        comment = true;
        continue;
      }
      value += " ".repeat(spaces);
      spaces = 0;
      if (c === "\\") {
        const escaped = next();
        if (escaped === "\n") continue;
        if (escaped === "t") value += "\t";
        else if (escaped === "b") value += "\b";
        else if (escaped === "n") value += "\n";
        else if (escaped === "\\" || escaped === '"') value += escaped;
        else return null;
        continue;
      }
      if (c === '"') {
        quote = !quote;
        continue;
      }
      value += c;
    }
  };

  const readSectionHeader = (): boolean => {
    let name = "";
    for (;;) {
      const c = next();
      if (c === "]") break;
      if (isSpace(c)) {
        // `[section "subsection"]`
        if (c === "\n") return false;
        let d = next();
        while (isSpace(d) && d !== "\n") d = next();
        if (d !== '"') return false;
        let sub = "";
        for (;;) {
          let e = next();
          if (e === "\n") return false;
          if (e === '"') break;
          if (e === "\\") {
            e = next();
            if (e === "\n") return false;
          }
          sub += e;
        }
        if (next() !== "]") return false;
        // git joins the two with a dot and splits the variable at its first dot.
        const base = name.toLowerCase();
        const dot = base.indexOf(".");
        section = dot < 0 ? base : base.slice(0, dot);
        subsection = dot < 0 ? sub : `${base.slice(dot + 1)}.${sub}`;
        return section.length > 0;
      }
      if (!isKeyChar(c) && c !== ".") return false;
      name += c;
    }
    // `[section.subsection]`, the old form: lowercased whole.
    const lowered = name.toLowerCase();
    const dot = lowered.indexOf(".");
    section = dot < 0 ? lowered : lowered.slice(0, dot);
    subsection = dot < 0 ? null : lowered.slice(dot + 1);
    return section.length > 0;
  };

  for (;;) {
    if (eof()) return entries;
    const c = next();
    if (isSpace(c)) continue;
    if (c === "#" || c === ";") {
      while (!eof() && next() !== "\n");
      continue;
    }
    if (c === "[") {
      if (!readSectionHeader()) return entries;
      continue;
    }
    if (!isAlpha(c) || section === null) return entries;
    let key = c;
    let d = next();
    while (isKeyChar(d)) {
      key += d;
      d = next();
    }
    while (d === " " || d === "\t") d = next();
    let value: string | null = null;
    if (d === "=") {
      value = readValue();
      if (value === null) return entries;
    } else if (d !== "\n") {
      return entries;
    }
    entries.push({ section, subsection, key: key.toLowerCase(), value });
  }
}

/** Percent-decoding as git's `url_decode` does it: a bad escape stays as it is. */
function percentDecode(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const isSeparator = (c: string | undefined): boolean => c === "/" || c === "\\";

/** git's `check_submodule_name`: not empty, and no `..` component under either separator. */
export function isSafeSubmoduleName(name: string): boolean {
  if (name === "") return false;
  for (let i = -1; i < name.length; i++) {
    if (i >= 0 && !isSeparator(name[i])) continue;
    if (
      name[i + 1] === "." &&
      name[i + 2] === "." &&
      (i + 3 >= name.length || isSeparator(name[i + 3]))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * git's `check_submodule_url`, except that a URL its normaliser would
 * refuse is let through here when it has no newline: that check is about
 * what a credential helper would be asked, which is the newline.
 */
export function isSafeSubmoduleUrl(url: string): boolean {
  if (url.startsWith("-")) return false;
  const relative = /^\.\.?[/\\]/.test(url);
  if (relative || url.startsWith("git://")) {
    if (percentDecode(url).includes("\n")) return false;
    let rest = url;
    let climbs = 0;
    for (;;) {
      if (/^\.\.[/\\]/.test(rest)) {
        climbs++;
        rest = rest.slice(3);
      } else if (/^\.[/\\]/.test(rest)) {
        rest = rest.slice(2);
      } else {
        break;
      }
    }
    return !(climbs > 0 && (rest.startsWith(":") || rest.startsWith("/")));
  }
  const curl =
    /^(?:https?|ftps?)::(.*)$/s.exec(url)?.[1] ?? (/^(?:https?|ftps?):\/\//.test(url) ? url : null);
  if (curl !== null) return !percentDecode(curl).includes("\n");
  return true;
}

/** Checks a `.gitmodules` file's content. */
export function fsckGitmodules(data: Uint8Array): void {
  for (const entry of readConfigEntries(data)) {
    if (entry.section !== "submodule" || entry.subsection === null) continue;
    if (!isSafeSubmoduleName(entry.subsection)) {
      throw refuse(`.gitmodules has a submodule name that is not allowed`);
    }
    const value = entry.value;
    if (value === null) continue;
    if (entry.key === "url" && !isSafeSubmoduleUrl(value)) {
      throw refuse(".gitmodules has a submodule url that is not allowed");
    }
    if (entry.key === "path" && value.startsWith("-")) {
      throw refuse(".gitmodules has a submodule path that reads as an option");
    }
    if (entry.key === "update" && value.startsWith("!")) {
      throw refuse(".gitmodules has a submodule update command");
    }
  }
}

/** Checks a `.gitattributes` file's content: git's limits on its size and its lines. */
export function fsckGitattributes(data: Uint8Array): void {
  if (data.length > MAX_GITATTRIBUTES_BYTES) throw refuse(".gitattributes is too large");
  // git reads the file as a C string, so a NUL ends it.
  const nul = data.indexOf(0);
  const end = nul < 0 ? data.length : nul;
  let start = 0;
  while (start < end) {
    let eol = data.indexOf(0x0a, start);
    if (eol < 0 || eol > end) eol = end;
    if (eol - start >= MAX_GITATTRIBUTES_LINE) throw refuse(".gitattributes has a line too long");
    start = eol + 1;
  }
}

/**
 * The checks above over a whole pack. Objects arrive in any order, so a
 * `.gitmodules` blob may pass before the tree that names it: `finish`
 * reads whatever special blob was not checked as it passed.
 */
export class ObjectFsck {
  /** Blob ids to check, and as which kind. */
  private readonly wanted = new Map<ObjectId, "gitmodules" | "gitattributes" | "both">();
  private readonly checked = new Set<ObjectId>();

  /** Checks one object. `data` may be null for a blob too large to have been kept. */
  note(oid: ObjectId, type: ObjectType, data: Uint8Array | null): void {
    switch (type) {
      case "tree": {
        if (data === null) throw refuse("a tree is too large to check");
        const found = fsckTree(data);
        for (const blob of found.gitmodules) this.want(blob, "gitmodules");
        for (const blob of found.gitattributes) this.want(blob, "gitattributes");
        return;
      }
      case "commit":
        if (data === null) throw refuse("a commit is too large to check");
        fsckCommit(data);
        return;
      case "tag":
        if (data === null) throw refuse("a tag is too large to check");
        fsckTag(data);
        return;
      case "blob":
        if (data !== null && this.wanted.has(oid)) this.checkBlob(oid, data);
    }
  }

  /** Special blobs named by a tree and not yet checked. */
  pending(): ObjectId[] {
    return [...this.wanted.keys()].filter((oid) => !this.checked.has(oid));
  }

  /**
   * Checks the special blobs that did not pass by with their content: the
   * ones earlier in the pack than their tree, large ones, and ones the
   * repository already had. `read` returns a blob's content, or null when
   * there is no such blob, which is refused as git refuses it.
   */
  async finish(read: (oid: ObjectId) => Promise<Uint8Array | null>): Promise<void> {
    for (const oid of this.pending()) {
      const data = await read(oid);
      if (data === null) throw refuse(`.gitmodules or .gitattributes blob ${oid} is missing`);
      this.checkBlob(oid, data);
    }
  }

  private want(oid: ObjectId, kind: "gitmodules" | "gitattributes"): void {
    const known = this.wanted.get(oid);
    if (known === undefined || known === kind) {
      this.wanted.set(oid, kind);
      return;
    }
    // Checked as one kind so far; it has to be read again as the other.
    if (known !== "both") this.checked.delete(oid);
    this.wanted.set(oid, "both");
  }

  private checkBlob(oid: ObjectId, data: Uint8Array): void {
    const kind = this.wanted.get(oid);
    if (kind === "gitmodules" || kind === "both") fsckGitmodules(data);
    if (kind === "gitattributes" || kind === "both") fsckGitattributes(data);
    this.checked.add(oid);
  }
}
