/** A merged branch page's review record as the contract's `MergedReview`. */
import type { MergedFinding, MergedReview } from "@infrawrench/git-contract";
import { pageKeys } from "../../db/branch-pages";
import type { FindingRow } from "../../db/findings";
import { type MergedPageRow, recordsOfPages } from "../../db/review-history";
import { iso, peopleById } from "./repositories";

const SEVERITY_RANK: Record<FindingRow["severity"], number> = {
  must_fix: 0,
  should_fix: 1,
  note: 2,
};

/**
 * The records of these pages, in the order given. `path` keeps only the
 * findings on that path; `asks` carries what each page's trace recorded as
 * the ask, where the caller read it.
 */
export const mergedReviewViews = async (
  pages: readonly MergedPageRow[],
  options: { readonly path?: string; readonly asks?: ReadonlyMap<string, string | null> } = {},
): Promise<MergedReview[]> => {
  const ids = pages.map((page) => page.issueId);
  const [records, keys] = await Promise.all([
    recordsOfPages(ids, options.path === undefined ? {} : { path: options.path }),
    pageKeys(pages),
  ]);
  const all = [...records.values()];
  const person = await peopleById([
    ...pages.map((page) => page.mergedByUserId),
    ...all.flatMap((record) => record.findings.map((finding) => finding.dismissedByUserId)),
    ...all.flatMap((record) => [...record.overrides.values()].map((override) => override.userId)),
  ]);
  return pages.flatMap((page) => {
    const key = keys.get(page.issueId);
    const record = records.get(page.issueId);
    if (key === undefined || record === undefined) return [];
    const findings: MergedFinding[] = record.findings
      .map((row, index) => ({ row, index }))
      // The gravest first; the read's own order (file, then line) within a severity.
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.row.severity] - SEVERITY_RANK[b.row.severity] || a.index - b.index,
      )
      .map(({ row }) => {
        // An override matters for a finding that was still open: it is why the merge went through.
        const override = row.status === "open" ? record.overrides.get(row.id) : undefined;
        return {
          id: row.id,
          reviewerKind: row.reviewerKind,
          severity: row.severity,
          title: row.title,
          path: row.path,
          side: row.side,
          startLine: row.startLine,
          endLine: row.endLine,
          linesAtHead: row.commitOid === page.headOid,
          status: row.status,
          version: row.versionNumber,
          fixedInVersion: row.fixedInVersionNumber,
          dismissedBy: person(row.dismissedByUserId),
          dismissalReason: row.dismissalReason,
          override: override ? { by: person(override.userId), reason: override.reason } : null,
        };
      });
    return [
      {
        page: { key, title: page.title, branch: page.headRef },
        mergeCommitOid: page.mergeCommitOid,
        mergeMethod: page.mergeMethod,
        mergedAt: iso(page.mergedAt),
        mergedBy: person(page.mergedByUserId),
        versions: record.versions,
        ask: options.asks?.get(page.issueId) ?? null,
        findings,
      },
    ];
  });
};
