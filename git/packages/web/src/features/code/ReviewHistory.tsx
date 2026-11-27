/**
 * What a merged branch page's review left, shown where the code is: the
 * Review section of the commit it was merged as, a file's review history,
 * and the mark beside a blamed line a finding was about. Each finding links
 * to itself on its branch page, where the whole of it is.
 */
import type { FindingSeverity, MergedFinding, MergedReview } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { Badge, type BadgeTone } from "../../components/Badge";
import { ButtonLink } from "../../components/Button";
import { Icon } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { showBidi } from "../../lib/bidi";
import { plural, shortOid } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";
import { SEVERITY_LABEL, describeLines } from "../review/branch";
import {
  type PlacedFinding,
  SEVERITY_ORDER,
  countFindings,
  findingHref,
  settledAs,
  settledText,
} from "./review-history";

const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  must_fix: "danger",
  should_fix: "warning",
  note: "neutral",
};

/** One finding as a merge left it: what it said, where, and how it was settled. */
function FindingRow({
  repo,
  pageKey,
  finding,
  where = true,
  severity = false,
}: {
  repo: RepoRef;
  pageKey: string;
  finding: MergedFinding;
  /** Name the file: everywhere but in that file's own history. */
  where?: boolean;
  /** Say the severity on the row: where the rows are not grouped by it. */
  severity?: boolean;
}) {
  const settled = settledAs(finding);
  const lines = describeLines(finding.startLine, finding.endLine);
  const place =
    finding.path === null
      ? null
      : where
        ? `${finding.path}${lines === null ? "" : `, ${lines.toLowerCase()}`}`
        : lines;
  return (
    <li className="px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {severity ? (
          <Badge tone={finding.status === "open" ? SEVERITY_TONE[finding.severity] : "outline"}>
            {SEVERITY_LABEL[finding.severity]}
          </Badge>
        ) : null}
        <AppLink
          href={findingHref(repo, pageKey, finding.id)}
          className="min-w-0 font-medium text-on-surface hover:underline"
        >
          {finding.title}
        </AppLink>
        <span className="text-on-surface-muted">{finding.reviewerKind}</span>
        {place !== null ? (
          <span className="min-w-0 truncate font-mono text-[11px] text-on-surface-muted">
            {showBidi(place)}
          </span>
        ) : null}
        <span className="flex-1" />
        {/* A note left open is a note, not something a merge went past. */}
        <Badge
          tone={
            finding.severity === "note" && settled.tone === "warning" ? "outline" : settled.tone
          }
        >
          {finding.status === "fixed" ? <Icon name="check" size={10} /> : null}
          {settled.label}
        </Badge>
      </div>
      {settled.detail !== null ? (
        <p className="mt-0.5 text-on-surface-secondary">
          {settled.detail.verb}
          {settled.detail.by !== null ? (
            <>
              {" by "}
              <UserLink user={settled.detail.by} className="align-bottom" />
            </>
          ) : null}
          {settled.detail.reason !== null ? `: ${settled.detail.reason}` : null}
        </p>
      ) : null}
    </li>
  );
}

/** `1 open at merge · 2 fixed · 1 dismissed`. */
function tally(findings: ReadonlyArray<MergedFinding>): string {
  const count = (status: MergedFinding["status"]) =>
    findings.filter((finding) => finding.status === status).length;
  const [open, fixed, dismissed] = [count("open"), count("fixed"), count("dismissed")];
  return [
    open > 0 ? `${open} open at merge` : null,
    fixed > 0 ? `${fixed} fixed` : null,
    dismissed > 0 ? `${dismissed} dismissed` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The review of the branch page a commit was merged as. */
export function CommitReviewSection({ repo, review }: { repo: RepoRef; review: MergedReview }) {
  const groups = SEVERITY_ORDER.map(
    (severity) =>
      [severity, review.findings.filter((finding) => finding.severity === severity)] as const,
  ).filter(([, findings]) => findings.length > 0);
  const counts = tally(review.findings);
  return (
    <Panel>
      <section aria-labelledby="commit-review">
        <PanelHeader
          actions={
            <ButtonLink size="sm" href={paths.branchPage(repo, review.page.key)}>
              <Icon name="fileDiff" size={12} />
              Branch page
            </ButtonLink>
          }
        >
          <Icon name="shield" />
          <h2 id="commit-review" className="font-medium text-on-surface">
            Review
          </h2>
          <span className="min-w-0 truncate">
            {plural(review.versions, "version")}
            {counts === "" ? "" : ` · ${counts}`}
          </span>
        </PanelHeader>
        {review.ask !== null ? (
          <div className="border-b border-border px-3 py-2 text-xs">
            <p className="mb-0.5 font-medium text-on-surface-muted">Ask</p>
            <div className="max-h-32 overflow-y-auto text-on-surface-secondary">
              <Markdown source={review.ask} />
            </div>
          </div>
        ) : null}
        {groups.length === 0 ? (
          <p className="px-3 py-3 text-xs text-on-surface-muted">No findings</p>
        ) : (
          groups.map(([severity, findings]) => (
            <div key={severity} className="border-b border-border last:border-b-0">
              <h3 className="px-3 pt-2 text-[11px] font-medium text-on-surface-muted">
                {SEVERITY_LABEL[severity]}
              </h3>
              <ul aria-label={SEVERITY_LABEL[severity]}>
                {findings.map((finding) => (
                  <FindingRow
                    key={finding.id}
                    repo={repo}
                    pageKey={review.page.key}
                    finding={finding}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
    </Panel>
  );
}

/** A file's review history: the findings merged branch pages left on its path, newest merge first. */
export function ReviewHistory({
  repo,
  pages,
  more,
  open,
  onToggle,
}: {
  repo: RepoRef;
  pages: ReadonlyArray<MergedReview>;
  /** Older pages were left out. */
  more: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  if (pages.length === 0) return null;
  return (
    <details
      id="review-history"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
      className="scroll-mt-24 border-b border-border text-xs"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-on-surface-muted hover:text-on-surface">
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <span className="font-medium">Review history</span>
        <span>
          {plural(countFindings(pages), "finding")} from{" "}
          {plural(pages.length, "merged branch", "merged branches")}
        </span>
      </summary>
      <ul className="divide-y divide-border border-t border-border">
        {pages.map((page) => (
          <li key={page.mergeCommitOid} className="py-1.5">
            <p className="flex flex-wrap items-center gap-x-2 px-3 text-on-surface-muted">
              <AppLink
                href={paths.branchPage(repo, page.page.key)}
                className="font-medium text-on-surface-secondary hover:underline"
              >
                {page.page.title}
              </AppLink>
              <span>
                merged <RelativeTime iso={page.mergedAt} />
              </span>
              <AppLink
                href={paths.commit(repo, page.mergeCommitOid)}
                className="font-mono text-[11px] hover:underline"
              >
                {shortOid(page.mergeCommitOid)}
              </AppLink>
            </p>
            <ul>
              {page.findings.map((finding) => (
                <FindingRow
                  key={finding.id}
                  repo={repo}
                  pageKey={page.page.key}
                  finding={finding}
                  where={false}
                  severity
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {more ? (
        <p className="border-t border-border px-3 py-1.5 text-on-surface-muted">
          Older branches are not listed
        </p>
      ) : null}
    </details>
  );
}

const DOT: Record<FindingSeverity, string> = {
  must_fix: "bg-danger",
  should_fix: "bg-warning",
  note: "bg-on-surface-muted",
};

/** What a mark says on hover: each finding's severity, how it was settled and its title. */
const markTitle = (placed: ReadonlyArray<PlacedFinding>): string =>
  placed
    .map(
      ({ finding }) =>
        `${SEVERITY_LABEL[finding.severity]} · ${settledText(finding)}\n${finding.title}`,
    )
    .join("\n\n");

/** The cell beside a blamed line: a dot on the first line a finding was about, a rule down the rest. */
export function BlameMark({
  repo,
  starts,
  covered,
}: {
  repo: RepoRef;
  starts: ReadonlyArray<PlacedFinding> | undefined;
  covered: PlacedFinding | undefined;
}) {
  const first = starts?.[0];
  if (first !== undefined && starts !== undefined) {
    const settled = first.finding.status !== "open";
    return (
      <AppLink
        href={findingHref(repo, first.page.page.key, first.finding.id)}
        title={markTitle(starts)}
        aria-label={`${plural(starts.length, "review finding")}: ${first.finding.title}`}
        className="flex h-5 w-4 items-center justify-center"
      >
        <span
          className={`size-1.5 rounded-full ${settled ? "bg-on-surface-faint" : DOT[first.finding.severity]}`}
        />
      </AppLink>
    );
  }
  if (covered !== undefined) {
    return (
      <span
        aria-hidden="true"
        title={markTitle([covered])}
        className="mx-auto block h-5 w-px bg-border-strong"
      />
    );
  }
  return null;
}
