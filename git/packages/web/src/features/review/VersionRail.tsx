/**
 * The versions of a branch as one slim strip, oldest first: each a small card
 * with its number, where the reader last reviewed, its age and its size. Who
 * pushed it and what it carries (comments, findings, a trace) are the card's
 * tooltip. Picking one shows it below.
 *
 * The strip scrolls sideways inside the page and never past its edge: it
 * opens at its end, where the newest version is, and fades at whichever side
 * has more.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BranchVersion } from "@infrawrench/git-contract";
import { Badge } from "../../components/Badge";
import { DiffStat } from "../../components/DiffView";
import { Icon, Spinner } from "../../components/icons";
import { ShortAge } from "../../components/people";
import { plural } from "../../lib/format";

/** What a card leaves out, as its tooltip. */
function detail(version: BranchVersion): string {
  const who = version.agent?.name ?? version.pusher?.username ?? "Someone";
  return [
    `Pushed by ${who}`,
    ...(version.counts.comments > 0 ? [plural(version.counts.comments, "comment")] : []),
    ...(version.counts.findings > 0 ? [plural(version.counts.findings, "finding")] : []),
    ...(version.hasTrace ? ["Has a trace"] : []),
  ].join(" · ");
}

/** The line from one version to the next. */
function Link() {
  return <span aria-hidden="true" className="h-px w-3 shrink-0 bg-border-strong" />;
}

/** How wide the fade at an end of the strip is. */
const FADE = "2.5rem";

export function VersionRail({
  versions,
  selected,
  reviewed,
  workingOn,
  onSelect,
}: {
  versions: ReadonlyArray<BranchVersion>;
  selected: number | null;
  /** The newest version the reader marked as reviewed. */
  reviewed: number | null;
  /** The version the agent's next push makes, while it is working. */
  workingOn: number | null;
  onSelect: (version: number) => void;
}) {
  const strip = useRef<HTMLOListElement>(null);
  // Which sides have more than is shown.
  const [more, setMore] = useState({ before: false, after: false });
  const measure = () => {
    const element = strip.current;
    if (element === null) return;
    const before = element.scrollLeft > 1;
    const after = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setMore((was) => (was.before === before && was.after === after ? was : { before, after }));
  };

  // It opens at its end: the newest version is the one being read.
  const count = versions.length + (workingOn !== null ? 1 : 0);
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null) return;
    element.scrollLeft = element.scrollWidth;
    measure();
  }, [count]);
  useEffect(() => {
    const element = strip.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const mask =
    more.before || more.after
      ? `linear-gradient(to right, ${more.before ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${more.after ? "transparent" : "black"})`
      : undefined;
  return (
    <nav aria-label="Versions" className="min-w-0">
      <ol
        ref={strip}
        onScroll={measure}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
        className="flex items-center overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {versions.map((version) => {
          const current = version.number === selected;
          const fresh = reviewed !== null && version.number > reviewed;
          return (
            <li key={version.id} className="flex shrink-0 items-center">
              {version.number === versions[0]?.number ? null : <Link />}
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                aria-label={`Version ${version.number}`}
                title={detail(version)}
                onClick={() => onSelect(version.number)}
                className={`flex h-8 items-center gap-2 rounded-full border px-3 text-left text-xs whitespace-nowrap ${
                  current
                    ? "border-on-surface bg-surface-raised"
                    : "border-border bg-surface hover:bg-surface-raised"
                }`}
              >
                <span className="font-mono text-[13px] font-semibold text-on-surface">
                  v{version.number}
                </span>
                {version.forced ? <Badge tone="warning">Forced</Badge> : null}
                {version.number === reviewed ? (
                  <Badge tone="neutral">
                    <Icon name="check" size={10} />
                    Reviewed
                  </Badge>
                ) : fresh ? (
                  <Badge tone="notice">New</Badge>
                ) : null}
                <ShortAge iso={version.createdAt} className="text-on-surface-muted" />
                {version.stats !== null ? (
                  <DiffStat
                    additions={version.stats.additions}
                    deletions={version.stats.deletions}
                  />
                ) : null}
              </button>
            </li>
          );
        })}
        {workingOn !== null ? (
          <li className="flex shrink-0 items-center">
            {versions.length > 0 ? <Link /> : null}
            <div
              role="status"
              className="flex h-8 items-center gap-2 rounded-full border border-dashed border-border px-3 text-xs whitespace-nowrap text-on-surface-muted"
            >
              <span className="font-mono text-[13px] font-semibold">v{workingOn}</span>
              <span className="flex items-center gap-1.5">
                <Spinner size={11} />
                In progress
              </span>
            </div>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
