/**
 * What a branch waiting on the reader has that is new to them, in words. The
 * list itself is the Reviews page (`features/workspace/ListPages.tsx`).
 */
import type { ReviewInboxItem } from "@infrawrench/git-contract";
import { plural } from "../../lib/format";

/** `2 new versions, 3 comments, 1 finding`, or that it has not been looked at. */
export function changesSentence(item: ReviewInboxItem): string {
  const { versions, comments, findings } = item.changes;
  const parts = [
    item.reviewedVersion === null ? plural(versions, "version") : plural(versions, "new version"),
    comments > 0 ? plural(comments, "comment") : null,
    findings > 0 ? plural(findings, "finding") : null,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}
