import { useEffect, useState } from "react";
import type { CiRun } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/icons";
import { RelativeTime, UserLink } from "../../components/people";
import { CiStatusIcon, ciStatusLabel } from "../../components/StatusIcons";
import { durationBetween, formatDuration } from "../../lib/amounts";
import { shortOid } from "../../lib/format";
import { paths, type RepoRef } from "../../lib/paths";

export const isActive = (run: Pick<CiRun, "status">): boolean =>
  run.status === "running" || run.status === "queued" || run.status === "pending";

/** Re-renders every second while `active`, for a running clock. */
export function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** How long a run took, or has been going. */
export function RunDuration({ run }: { run: CiRun }) {
  const now = useSecondTick(run.status === "running");
  const text = formatDuration(durationBetween(run.startedAt, run.finishedAt, now));
  if (text === "") return null;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon name="clock" size={11} />
      <span className="sr-only">Duration</span>
      {text}
    </span>
  );
}

const EVENT_LABEL = {
  push: "Push",
  "pull-request": "Pull request",
  schedule: "Schedule",
  manual: "Manual",
} as const;

/** What started a run: the event, and the pull request when there is one. */
export function RunEvent({ run, repo }: { run: CiRun; repo: RepoRef }) {
  if (run.event === "pull-request" && run.pullNumber !== null) {
    return (
      <AppLink
        href={paths.pull(repo, run.pullNumber)}
        className="inline-flex items-center gap-1 hover:text-on-surface hover:underline"
      >
        <Icon name="gitPullRequest" size={11} />#{run.pullNumber}
      </AppLink>
    );
  }
  return <span>{EVENT_LABEL[run.event]}</span>;
}

const chip =
  "inline-flex max-w-48 items-center gap-1 rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-on-surface-secondary";

export function RunRow({ run, repo }: { run: CiRun; repo: RepoRef }) {
  return (
    <li className="flex items-start gap-2.5 border-t border-border px-3 py-2 first:border-t-0 hover:bg-surface-inset">
      <span className="mt-0.5">
        <CiStatusIcon status={run.status} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <AppLink
            href={paths.ciRun(repo, run.id)}
            className="min-w-0 truncate text-sm font-medium text-on-surface hover:underline"
          >
            {run.commitTitle ?? shortOid(run.sha)}
          </AppLink>
          {run.fromFork ? <Badge tone="outline">Fork</Badge> : null}
          {run.status === "awaiting_approval" ||
          run.status === "cancelled" ||
          run.status === "rejected" ? (
            <Badge tone={run.status === "awaiting_approval" ? "warning" : "neutral"}>
              {ciStatusLabel(run.status)}
            </Badge>
          ) : null}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-on-surface-muted">
          <RunEvent run={run} repo={repo} />
          <span className={chip}>
            <Icon name="gitBranch" size={10} />
            <span className="truncate">{run.headRef}</span>
          </span>
          <AppLink href={paths.commit(repo, run.sha)} className={`${chip} hover:underline`}>
            {shortOid(run.sha)}
          </AppLink>
          {run.actor !== null ? (
            <UserLink user={run.actor} className="font-normal text-on-surface-secondary" />
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-xs text-on-surface-muted">
        <RelativeTime iso={run.createdAt} />
        <RunDuration run={run} />
      </div>
    </li>
  );
}
