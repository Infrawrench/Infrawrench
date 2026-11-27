/**
 * `needsCode`: whether a reader has to see the code a trace entry or a
 * finding is about to understand it. The page shows the anchored lines
 * beside the text when it is true and the text alone when it is false.
 *
 * It is resolved once, when the entry is written, and stored, so a row says
 * the same thing to every reader and a later change to the rule leaves what
 * was written alone:
 *
 * - **Left out**: true when the entry points at lines, false otherwise.
 * - **Said false**: false. Most decisions and doubts stand on their own,
 *   whatever they are anchored to.
 * - **Said true**: true when the entry points at a file at all. With no file
 *   there is no code to show.
 */

/** What an entry points at, as far as showing code goes. */
export interface CodeAnchor {
  /** It names a file. */
  readonly file: boolean;
  /** It names lines in a file. */
  readonly line: boolean;
}

export const resolveNeedsCode = (said: boolean | null | undefined, anchor: CodeAnchor): boolean =>
  said == null ? anchor.file && anchor.line : said && anchor.file;

/** A trace entry's anchors: lines are an anchor's `startLine`. */
export const traceCodeAnchor = (
  anchors: ReadonlyArray<{ readonly startLine?: number | null | undefined }>,
): CodeAnchor => ({
  file: anchors.length > 0,
  line: anchors.some((anchor) => anchor.startLine != null),
});

/** A finding's anchor: a path, and either end of its lines. */
export const findingCodeAnchor = (finding: {
  readonly path: string | null;
  readonly startLine: number | null;
  readonly endLine: number | null;
}): CodeAnchor => ({
  file: finding.path !== null,
  line: finding.path !== null && (finding.startLine !== null || finding.endLine !== null),
});
