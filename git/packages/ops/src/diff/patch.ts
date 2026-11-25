/**
 * Patch text: what `.diff` and `.patch` downloads serve. The diff body is
 * `git diff --full-index` byte for byte (full ids, because abbreviating
 * needs to know every object in the repository); the mail wrapper follows
 * `git format-patch`.
 */
import {
  type Commit,
  type ObjectId,
  type ObjectReader,
  ZERO_OID,
  concatBytes,
  encodeText,
  messageSubject,
  streamFrom,
} from "@infrawrench/git-core";
import { cacheOf } from "../objects";
import { type DiffOptions, type RawFileDiff, diffFile, diffTreeFiles } from "./diff";
import { hunkHeader, hunkLines } from "./hunks";
import { hasNewline, lineBytes } from "./lines";
import type { FileChange } from "./renames";

const ESCAPES: Record<number, string> = {
  0x07: "\\a",
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0b: "\\v",
  0x0c: "\\f",
  0x0d: "\\r",
  0x22: '\\"',
  0x5c: "\\\\",
};

/**
 * Git's C-style quoting for a path in a diff header: left alone unless it
 * has a control character, a quote, a backslash or a byte outside ASCII,
 * and then quoted with octal escapes.
 */
export function quotePath(path: string): string {
  const bytes = encodeText(path);
  let needs = false;
  for (const byte of bytes) {
    if (byte < 0x20 || byte >= 0x7f || byte === 0x22 || byte === 0x5c) {
      needs = true;
      break;
    }
  }
  if (!needs) return path;
  let out = '"';
  for (const byte of bytes) {
    const escape = ESCAPES[byte];
    if (escape !== undefined) out += escape;
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}"`;
}

interface Side {
  readonly path: string;
  readonly mode: string;
  readonly oid: ObjectId;
}

/** The header lines of one `diff --git` block, up to and including `index`. */
function fileHeader(change: FileChange, old: Side | null, next: Side | null): string {
  const aPath = old?.path ?? next!.path;
  const bPath = next?.path ?? old!.path;
  let out = `diff --git ${quotePath(`a/${aPath}`)} ${quotePath(`b/${bPath}`)}\n`;
  if (old === null) out += `new file mode ${next!.mode}\n`;
  else if (next === null) out += `deleted file mode ${old.mode}\n`;
  else {
    if (old.mode !== next.mode) out += `old mode ${old.mode}\nnew mode ${next.mode}\n`;
    if (change.status === "renamed" || change.status === "copied") {
      const verb = change.status === "renamed" ? "rename" : "copy";
      out += `similarity index ${change.similarity ?? 100}%\n`;
      out += `${verb} from ${quotePath(old.path)}\n${verb} to ${quotePath(next.path)}\n`;
    }
  }
  const oldOid = old?.oid ?? ZERO_OID;
  const newOid = next?.oid ?? ZERO_OID;
  if (oldOid !== newOid) {
    const mode = old !== null && next !== null && old.mode === next.mode ? ` ${old.mode}` : "";
    out += `index ${oldOid}..${newOid}${mode}\n`;
  }
  return out;
}

function fileLabels(old: Side | null, next: Side | null): { a: string; b: string } {
  return {
    a: old === null ? "/dev/null" : quotePath(`a/${old.path}`),
    b: next === null ? "/dev/null" : quotePath(`b/${next.path}`),
  };
}

const NO_NEWLINE = encodeText("\\ No newline at end of file\n");
const NEWLINE = encodeText("\n");

function block(raw: RawFileDiff, old: Side | null, next: Side | null): Uint8Array[] {
  const chunks: Uint8Array[] = [encodeText(fileHeader(raw.change, old, next))];
  const labels = fileLabels(old, next);
  if (raw.binary || raw.tooLarge) {
    // A file too large to diff is announced the way a binary one is: the patch says it changed.
    chunks.push(encodeText(`Binary files ${labels.a} and ${labels.b} differ\n`));
    return chunks;
  }
  if (raw.hunks.length === 0) return chunks;
  // GNU patch needs a tab after a name with a space in it to know where the name ends.
  const tab = (label: string): string => (label.includes(" ") ? "\t" : "");
  chunks.push(encodeText(`--- ${labels.a}${tab(labels.a)}\n+++ ${labels.b}${tab(labels.b)}\n`));
  for (const hunk of raw.hunks) {
    chunks.push(encodeText(`${hunkHeader(hunk)}\n`));
    for (const line of hunkLines(hunk)) {
      const fromOld = line.kind === "delete";
      const source = fromOld ? raw.oldLines : raw.newLines;
      const index = fromOld ? line.oldIndex : line.newIndex;
      chunks.push(encodeText(line.kind === "context" ? " " : fromOld ? "-" : "+"));
      chunks.push(lineBytes(source, index));
      if (!hasNewline(source, index)) chunks.push(NEWLINE, NO_NEWLINE);
    }
  }
  return chunks;
}

function side(path: string | null, entry: FileChange["old"]): Side | null {
  return path === null || entry === null ? null : { path, mode: entry.mode, oid: entry.oid };
}

/** One file's patch text. A change of type is a deletion followed by a creation, as git writes it. */
export async function filePatch(
  reader: ObjectReader,
  change: FileChange,
  options: DiffOptions = {},
): Promise<Uint8Array> {
  const old = side(change.oldPath, change.old);
  const next = side(change.newPath, change.new);
  if (change.status === "type-changed") {
    const removal: FileChange = { ...change, status: "deleted", newPath: null, new: null };
    const creation: FileChange = { ...change, status: "added", oldPath: null, old: null };
    return concatBytes([
      ...block(await diffFile(reader, removal, options), old, null),
      ...block(await diffFile(reader, creation, options), null, next),
    ]);
  }
  return concatBytes(block(await diffFile(reader, change, options), old, next));
}

/** The patch between two trees as a stream, one file at a time, so a large diff is never held whole. */
export function patchStream(
  reader: ObjectReader,
  oldTree: ObjectId | null,
  newTree: ObjectId | null,
  options: DiffOptions = {},
): ReadableStream<Uint8Array> {
  const cache = cacheOf(reader, options.limits);
  async function* generate(): AsyncGenerator<Uint8Array, void, void> {
    const { changes } = await diffTreeFiles(cache, oldTree, newTree, options);
    for (const change of changes) {
      const text = await filePatch(cache, change, options);
      if (text.length > 0) yield text;
    }
  }
  return streamFrom(generate());
}

export interface StatEntry {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

function statName(change: FileChange): string {
  if (change.status === "renamed" || change.status === "copied") {
    return `${quotePath(change.oldPath!)} => ${quotePath(change.newPath!)}`;
  }
  return quotePath(change.newPath ?? change.oldPath!);
}

function scale(value: number, width: number, max: number): number {
  return value === 0 ? 0 : 1 + Math.floor((value * (width - 1)) / max);
}

/**
 * A `--stat` block: one line per file with a bar scaled to fit, then the
 * totals. The counts are git's; the layout follows git's but is not
 * promised byte for byte (git shortens long names and renames differently).
 */
export function formatStat(entries: readonly StatEntry[], width = 80): string {
  if (entries.length === 0) return "";
  let maxChange = 0;
  let nameWidth = 0;
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    nameWidth = Math.max(nameWidth, entry.path.length);
    maxChange = Math.max(maxChange, entry.additions + entry.deletions);
    additions += entry.additions;
    deletions += entry.deletions;
  }
  const numberWidth = Math.max(String(maxChange).length, entries.some((e) => e.binary) ? 3 : 1);
  let graphWidth = maxChange;
  if (nameWidth + numberWidth + 6 + graphWidth > width) {
    const most = Math.floor((width * 3) / 8) - numberWidth - 6;
    if (graphWidth > most) graphWidth = Math.max(most, 6);
    if (nameWidth > width - numberWidth - 6 - graphWidth) {
      nameWidth = width - numberWidth - 6 - graphWidth;
    } else graphWidth = width - numberWidth - 6 - nameWidth;
  }
  let out = "";
  for (const entry of entries) {
    let name = entry.path;
    if (name.length > nameWidth) {
      name = name.slice(name.length - (nameWidth - 3));
      const slash = name.indexOf("/");
      name = `...${slash >= 0 ? name.slice(slash) : name}`;
    }
    out += ` ${name.padEnd(nameWidth)} | `;
    if (entry.binary) {
      out += `${"Bin".padStart(numberWidth)}\n`;
      continue;
    }
    let add = entry.additions;
    let del = entry.deletions;
    if (graphWidth <= maxChange && maxChange > 0) {
      let total = scale(add + del, graphWidth, maxChange);
      if (total < 2 && add > 0 && del > 0) total = 2;
      if (add < del) {
        add = scale(add, graphWidth, maxChange);
        del = total - add;
      } else {
        del = scale(del, graphWidth, maxChange);
        add = total - del;
      }
    }
    const count = String(entry.additions + entry.deletions).padStart(numberWidth);
    out += `${count}${add + del > 0 ? " " : ""}${"+".repeat(add)}${"-".repeat(del)}\n`;
  }
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  out += ` ${plural(entries.length, "file")} changed`;
  if (additions > 0 || deletions === 0) out += `, ${plural(additions, "insertion")}(+)`;
  if (deletions > 0 || additions === 0) out += `, ${plural(deletions, "deletion")}(-)`;
  return `${out}\n`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Tue, 14 Nov 2023 22:13:20 +0100`: the moment as the author's clock read it. */
export function formatMailDate(timestamp: number, timezoneOffset: number): string {
  const local = new Date((timestamp + timezoneOffset * 60) * 1000);
  const two = (n: number): string => String(n).padStart(2, "0");
  const negative = timezoneOffset < 0 || Object.is(timezoneOffset, -0);
  const minutes = Math.abs(timezoneOffset);
  const zone = `${negative ? "-" : "+"}${two(Math.floor(minutes / 60))}${two(minutes % 60)}`;
  return (
    `${DAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ` +
    `${local.getUTCFullYear()} ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:` +
    `${two(local.getUTCSeconds())} ${zone}`
  );
}

/** A header value as RFC 2047 Q-encoding when it is not plain ASCII. */
function mailHeader(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  let out = "";
  for (const byte of encodeText(text)) {
    const plain =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a);
    out += plain
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `=?UTF-8?q?${out}?=`;
}

export interface FormatPatchOptions extends DiffOptions {
  /** The line after `-- ` at the end, where git puts its version. */
  readonly signature?: string;
}

/**
 * One commit as a mailbox-format patch (`git format-patch -1 --stdout
 * --full-index`): headers, message, stat, diff. `git am` applies it,
 * except for binary changes, which are named but not carried.
 */
export async function formatPatch(
  reader: ObjectReader,
  oid: ObjectId,
  options: FormatPatchOptions = {},
): Promise<Uint8Array> {
  const cache = cacheOf(reader, options.limits);
  const commit: Commit = await cache.commit(oid);
  const parent = commit.parents[0];
  const parentTree = parent ? (await cache.node(parent)).tree : null;
  const { changes } = await diffTreeFiles(cache, parentTree, commit.tree, options);

  const stats: StatEntry[] = [];
  const bodies: Uint8Array[] = [];
  for (const change of changes) {
    const raw = await diffFile(cache, change, options);
    stats.push({
      path: statName(change),
      additions: raw.additions,
      deletions: raw.deletions,
      binary: raw.binary || raw.tooLarge,
    });
    bodies.push(await filePatch(cache, change, options));
  }

  // The subject is the first paragraph on one line; the rest of the message is the body.
  const message = commit.message.replace(/^\n+/, "");
  const paragraphEnd = message.search(/\n[ \t]*\n/);
  const firstParagraph = paragraphEnd < 0 ? message : message.slice(0, paragraphEnd);
  const subject = firstParagraph.trimEnd().split("\n").join(" ") || messageSubject(message);
  const body = paragraphEnd < 0 ? "" : message.slice(paragraphEnd).replace(/^\s*\n/, "");
  const author = commit.author;

  let head = `From ${oid} Mon Sep 17 00:00:00 2001\n`;
  head += `From: ${mailHeader(author.name)} <${author.email}>\n`;
  head += `Date: ${formatMailDate(author.timestamp, author.timezoneOffset)}\n`;
  head += `Subject: [PATCH] ${mailHeader(subject)}\n\n`;
  if (body !== "") head += body.endsWith("\n") ? body : `${body}\n`;
  head += `---\n${formatStat(stats, 72)}\n`;
  return concatBytes([
    encodeText(head),
    ...bodies,
    encodeText(`-- \n${options.signature ?? "git.infrawrench.com"}\n\n`),
  ]);
}
