/**
 * The versions of a branch in a row, oldest first: who pushed each, where
 * the reader last reviewed, and which carry comments, findings or a trace.
 * Picking one shows it below.
 */
import type { BranchVersion } from "@infrawrench/git-contract";
import { Badge } from "../../components/Badge";
import { DiffStat } from "../../components/DiffView";
import { Icon, Spinner } from "../../components/icons";
import { RelativeTime } from "../../components/people";

function Count({
  icon,
  count,
  label,
}: {
  icon: "messageSquare" | "shield";
  count: number;
  label: string;
}) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-0.5" title={`${count} ${label}`}>
      <Icon name={icon} size={11} />
      <span className="sr-only">{label}:</span>
      {count}
    </span>
  );
}

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
  return (
    <nav aria-label="Versions">
      <ol className="flex gap-1.5 overflow-x-auto pb-1">
        {versions.map((version) => {
          const current = version.number === selected;
          const fresh = reviewed !== null && version.number > reviewed;
          const who = version.agent?.name ?? version.pusher?.username ?? "Someone";
          return (
            <li key={version.id} className="shrink-0">
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                aria-label={`Version ${version.number}`}
                onClick={() => onSelect(version.number)}
                className={`flex h-full w-44 flex-col gap-1 rounded-md border px-2.5 py-1.5 text-left text-xs ${
                  current
                    ? "border-border-strong bg-surface-raised"
                    : "border-border bg-surface hover:bg-surface-raised"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-sm font-semibold text-on-surface">
                    v{version.number}
                  </span>
                  {version.forced ? <Badge tone="warning">Forced</Badge> : null}
                  {version.number === reviewed ? (
                    <Badge tone="success">
                      <Icon name="check" size={10} />
                      Reviewed
                    </Badge>
                  ) : fresh ? (
                    <Badge tone="notice">New</Badge>
                  ) : null}
                </span>
                <span className="flex items-center gap-1 text-on-surface-muted">
                  {version.agent !== null ? <Icon name="bot" size={11} /> : null}
                  <span className="min-w-0 truncate">{who}</span>
                  <span aria-hidden="true">·</span>
                  <RelativeTime iso={version.createdAt} className="shrink-0" />
                </span>
                <span className="flex items-center gap-2 text-on-surface-muted">
                  {version.stats !== null ? (
                    <DiffStat
                      additions={version.stats.additions}
                      deletions={version.stats.deletions}
                    />
                  ) : null}
                  <Count icon="messageSquare" count={version.counts.comments} label="comments" />
                  <Count icon="shield" count={version.counts.findings} label="findings" />
                  {version.hasTrace ? (
                    <span className="inline-flex items-center" title="Has a trace">
                      <Icon name="history" size={11} />
                      <span className="sr-only">Has a trace</span>
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
        {workingOn !== null ? (
          <li className="shrink-0">
            <div
              role="status"
              className="flex h-full w-36 flex-col justify-center gap-1 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-on-surface-muted"
            >
              <span className="font-mono text-sm font-semibold">v{workingOn}</span>
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
