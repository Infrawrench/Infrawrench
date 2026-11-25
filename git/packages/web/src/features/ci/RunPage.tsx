import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CiRun } from "@infrawrench/git-contract";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { buttonClass } from "../../components/Button";
import { Breadcrumbs } from "../../components/controls";
import { Icon } from "../../components/icons";
import { Page, Panel, PanelHeader } from "../../components/Panel";
import { RelativeTime, UserLink } from "../../components/people";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { CiStatusIcon, ciStatusLabel } from "../../components/StatusIcons";
import { useRepoRef } from "../../layout/RepoLayout";
import { formatDuration } from "../../lib/amounts";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import { IS_MOCK } from "../../lib/session";
import { LogViewer } from "./LogViewer";
import {
  followRunLog,
  jobKey,
  pickJob,
  reduceFrames,
  runFromReport,
  type LiveJob,
  type LiveRun,
  type SseFrame,
} from "./live";
import { RunDuration, RunEvent, isActive } from "./RunRow";

/** A run in progress, from its log as it is written. */
function useLiveRun(runId: string, enabled: boolean): { run: LiveRun | null; error: unknown } {
  const repo = useRepoRef();
  const { owner, repo: name } = repo;
  const [frames, setFrames] = useState<SseFrame[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setError(null);
    followRunLog({ owner, repo: name }, runId, setFrames, controller.signal, IS_MOCK)
      // The run ended: the finished report replaces the log.
      .then(() => void invalidate("ci"))
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught);
      });
    return () => controller.abort();
  }, [enabled, owner, name, runId]);
  const run = useMemo(() => (frames === null ? null : reduceFrames(frames)), [frames]);
  return { run, error };
}

function JobList({
  run,
  runId,
  selected,
}: {
  run: LiveRun;
  runId: string;
  selected: LiveJob | null;
}) {
  const repo = useRepoRef();
  const pipelines = [...new Set(run.jobs.map((job) => job.pipeline))];
  return (
    <nav aria-label="Jobs" className="space-y-3">
      {pipelines.map((pipeline) => (
        <div key={pipeline}>
          <h2 className="mb-1 flex items-center gap-1.5 px-2 text-xs font-semibold text-on-surface-secondary">
            <Icon name="listChecks" size={12} />
            {pipeline}
          </h2>
          <ul>
            {run.jobs
              .filter((job) => job.pipeline === pipeline)
              .map((job) => {
                const active = selected !== null && jobKey(selected) === jobKey(job);
                return (
                  <li key={job.id}>
                    <AppLink
                      replace
                      href={paths.ciRun(repo, runId, jobKey(job))}
                      aria-current={active ? "true" : undefined}
                      className={`flex items-center gap-2 rounded px-2 py-1.5 text-xs ${
                        active
                          ? "bg-surface-sunken font-medium text-on-surface"
                          : "text-on-surface-secondary hover:bg-surface-sunken"
                      }`}
                    >
                      <CiStatusIcon status={job.status === "pending" ? "waiting" : job.status} />
                      <span className="min-w-0 flex-1 truncate">{job.name}</span>
                      <span className="shrink-0 text-on-surface-muted">
                        {formatDuration(job.durationMs)}
                      </span>
                    </AppLink>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function RunHeader({ run }: { run: CiRun }) {
  const repo = useRepoRef();
  return (
    <div className="mb-4 space-y-2 border-b border-border pb-3">
      <Breadcrumbs
        label="CI"
        crumbs={[{ label: "CI", href: paths.ci(repo) }, { label: `Run ${run.id}` }]}
      />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold text-on-surface">
          <CiStatusIcon status={run.status} size={18} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {run.commitTitle ?? shortOid(run.sha)}
          </span>
        </h1>
        {run.appUrl !== null ? (
          <a
            href={run.appUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonClass("secondary")}
          >
            {run.status === "awaiting_approval"
              ? "Approve in Infrawrench"
              : isActive(run)
                ? "Cancel in Infrawrench"
                : "Retry in Infrawrench"}
            <Icon name="externalLink" size={12} />
          </a>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-on-surface-muted">
        <Badge
          tone={
            run.status === "passed"
              ? "success"
              : run.status === "failed" || run.status === "error" || run.status === "rejected"
                ? "danger"
                : run.status === "running" || run.status === "awaiting_approval"
                  ? "warning"
                  : "neutral"
          }
        >
          {ciStatusLabel(run.status)}
        </Badge>
        <RunEvent run={run} repo={repo} />
        <AppLink
          href={paths.tree(repo, run.headRef)}
          className="inline-flex items-center gap-1 font-mono text-[11px] text-on-surface-secondary hover:underline"
        >
          <Icon name="gitBranch" size={11} />
          {run.headRef}
        </AppLink>
        <AppLink
          href={paths.commit(repo, run.sha)}
          className="font-mono text-[11px] text-on-surface-secondary hover:underline"
        >
          {shortOid(run.sha)}
        </AppLink>
        {run.actor !== null ? <UserLink user={run.actor} /> : null}
        <RelativeTime iso={run.createdAt} />
        <RunDuration run={run} />
        {run.pipelineFile !== undefined ? (
          <span className="font-mono text-[11px]">{run.pipelineFile}</span>
        ) : null}
      </div>
      {run.statusReason !== null ? (
        <p className="text-xs text-on-surface-secondary">{run.statusReason}</p>
      ) : null}
    </div>
  );
}

export function RunPage({ runId, job }: { runId: string; job: string | undefined }) {
  const repo = useRepoRef();
  const detail = useQuery({
    ...queries.ci.getRun({ params: { ...repo, runId } }),
    refetchInterval: (query) =>
      query.state.data !== undefined && isActive(query.state.data.run) ? 3000 : false,
  });
  const reported = detail.data?.jobs ?? null;
  const running = detail.data?.run.status === "running" && reported === null;
  const live = useLiveRun(runId, running);
  const finished = useMemo(() => (reported === null ? null : runFromReport(reported)), [reported]);
  const run = finished ?? live.run;

  return (
    <Page>
      <QueryView query={detail}>
        {(data) => {
          const selected = run === null ? null : pickJob(run, job);
          return (
            <>
              <RunHeader run={data.run} />
              {run === null || run.jobs.length === 0 ? (
                <Panel>
                  <EmptyState>
                    {data.run.status === "awaiting_approval"
                      ? "Waiting for approval"
                      : data.run.status === "queued" || data.run.status === "pending"
                        ? "Waiting to start"
                        : running
                          ? "Starting"
                          : "This run has no jobs"}
                  </EmptyState>
                  <InlineError error={live.error} />
                </Panel>
              ) : (
                <div className="grid gap-4 md:grid-cols-[15rem_minmax(0,1fr)]">
                  <JobList run={run} runId={runId} selected={selected} />
                  {selected !== null ? (
                    <Panel>
                      <PanelHeader
                        actions={
                          <span className="text-on-surface-muted">
                            {formatDuration(selected.durationMs)}
                          </span>
                        }
                      >
                        <CiStatusIcon
                          status={selected.status === "pending" ? "waiting" : selected.status}
                        />
                        <span className="font-medium text-on-surface">{selected.name}</span>
                        {selected.reason !== null ? <span>{selected.reason}</span> : null}
                        {selected.needs.length > 0 ? (
                          <span>after {selected.needs.join(", ")}</span>
                        ) : null}
                      </PanelHeader>
                      {selected.status === "pending" ? (
                        <EmptyState>Waiting to start</EmptyState>
                      ) : selected.status === "skipped" ? (
                        <EmptyState>Skipped</EmptyState>
                      ) : (
                        <LogViewer
                          key={jobKey(selected)}
                          lines={selected.lines}
                          label={selected.name}
                          following={selected.status === "running"}
                        />
                      )}
                      {run.truncated ? (
                        <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
                          The log was cut off at the runner's limit
                        </p>
                      ) : null}
                      <InlineError error={live.error} />
                    </Panel>
                  ) : null}
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </Page>
  );
}
