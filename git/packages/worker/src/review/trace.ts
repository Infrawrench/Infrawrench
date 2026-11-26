/**
 * What a trace entry goes through on its way into `git_trace_entries`:
 * masked, and held to its limits. Pure, so the handler (`api/handlers/traces.ts`)
 * only decides who may write and where.
 *
 * The limits, and why each is where it is:
 *
 * - **A body** is a paragraph or a few, not a document: refused past
 *   {@link TRACE_LIMITS.bodyBytes}, because cutting markdown in the middle
 *   leaves a broken note.
 * - **An output excerpt** is cut, not refused: an agent pastes what a command
 *   printed and should not have to measure it. The head and the tail are
 *   kept (a test run's summary is at the end) with a line in between saying
 *   how much is gone. A command is cut at its end the same way.
 * - **Entries waiting on a branch** are bounded, and so are the branches a
 *   repository has entries waiting on: a branch need not exist to be written
 *   to, so without the second bound the first bounds nothing.
 *
 * Sizes are UTF-8 bytes, which is what is stored. The contract's schema
 * bounds the same fields in UTF-16 units, further out: it refuses the absurd
 * before this is reached.
 */
import type {
  GitAgentIdentity,
  GitTraceAnchor,
  GitTraceEvidence,
  GitTraceKind,
} from "@infrawrench/server-core/db/schema";
import { maskSecrets } from "./masking";

export const TRACE_LIMITS = {
  /** One entry's markdown. */
  bodyBytes: 32 * 1024,
  /** One evidence entry's output, after cutting. */
  outputBytes: 16 * 1024,
  /** Of {@link outputBytes}, how much is the excerpt's start. The rest is its end. */
  outputHeadBytes: 4 * 1024,
  commandBytes: 4 * 1024,
  /** Entries waiting for the next push to one branch. */
  pendingPerBranch: 1000,
  /** Entries waiting on all of a repository's branches together. */
  pendingPerRepository: 20_000,
  /** How long an entry waits for a push before it is dropped (`review/prune.ts`). */
  pendingDays: 30,
} as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const byteLength = (text: string): number => encoder.encode(text).length;

/** The first `bytes` of `text`, never ending inside a character. */
const headBytes = (text: string, bytes: number): string => {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let end = bytes;
  // A continuation byte is `10xxxxxx`: step back to the start of its character.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(encoded.subarray(0, end));
};

/** The last `bytes` of `text`, never starting inside a character. */
const tailBytes = (text: string, bytes: number): string => {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  let start = encoded.length - bytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(encoded.subarray(start));
};

/**
 * An excerpt held to `limit` bytes: its start and its end, with a line
 * between them saying how much was left out.
 */
export const excerpt = (text: string, limit: number, head: number): string => {
  const size = byteLength(text);
  if (size <= limit) return text;
  // Room for the marker's own line, whatever number it names.
  const tail = Math.max(0, limit - head - 64);
  const start = headBytes(text, head);
  const end = tailBytes(text, tail);
  const omitted = size - byteLength(start) - byteLength(end);
  return `${start}\n[... ${omitted} bytes left out ...]\n${end}`;
};

/** An entry as a caller sent it, after the contract's schema. */
export interface TraceEntryInput {
  readonly kind: GitTraceKind;
  readonly body: string;
  readonly anchors?: readonly GitTraceAnchor[] | undefined;
  readonly evidence?: GitTraceEvidence | null | undefined;
}

/** An entry as it is stored. */
export interface PreparedTraceEntry {
  readonly kind: GitTraceKind;
  readonly body: string;
  readonly anchors: GitTraceAnchor[];
  readonly evidence: GitTraceEvidence | null;
}

export type TraceRefusal = { readonly reason: "body_too_large"; readonly index: number };

const prepareEvidence = (evidence: GitTraceEvidence): GitTraceEvidence => ({
  // Masked first and cut after: a secret cut in half no longer has its shape.
  command:
    evidence.command == null
      ? null
      : excerpt(
          maskSecrets(evidence.command),
          TRACE_LIMITS.commandBytes,
          TRACE_LIMITS.commandBytes - 64,
        ),
  exitCode: evidence.exitCode ?? null,
  output:
    evidence.output == null
      ? null
      : excerpt(
          maskSecrets(evidence.output),
          TRACE_LIMITS.outputBytes,
          TRACE_LIMITS.outputHeadBytes,
        ),
  ciRunId: evidence.ciRunId ?? null,
  url: evidence.url == null ? null : maskSecrets(evidence.url),
});

/**
 * Mask every entry and hold it to its limits. Nothing an entry carries
 * reaches the table without passing {@link maskSecrets}: its body, its
 * command, its output, its link and the paths it points at.
 */
export const prepareTraceEntries = (
  entries: readonly TraceEntryInput[],
): PreparedTraceEntry[] | TraceRefusal => {
  const prepared: PreparedTraceEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const body = maskSecrets(entry.body);
    if (byteLength(body) > TRACE_LIMITS.bodyBytes) return { reason: "body_too_large", index };
    prepared.push({
      kind: entry.kind,
      body,
      anchors: (entry.anchors ?? []).map((anchor) => ({
        path: maskSecrets(anchor.path),
        startLine: anchor.startLine ?? null,
        // A range that ends before it starts is one line.
        endLine:
          anchor.endLine == null || anchor.startLine == null
            ? (anchor.endLine ?? null)
            : Math.max(anchor.startLine, anchor.endLine),
      })),
      evidence: entry.evidence == null ? null : prepareEvidence(entry.evidence),
    });
  }
  return prepared;
};

/** Who an agent said it is, masked like everything else it sent. */
export const prepareAgent = (
  agent:
    | { readonly kind: string; readonly name: string; readonly sessionRef?: string | null }
    | undefined,
): GitAgentIdentity | null =>
  agent === undefined
    ? null
    : {
        kind: maskSecrets(agent.kind),
        name: maskSecrets(agent.name),
        sessionRef: agent.sessionRef == null ? null : maskSecrets(agent.sessionRef),
      };
