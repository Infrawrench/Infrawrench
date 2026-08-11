import { useCallback, useEffect, useState } from "react";
import { DEPLOY_STAGES, formatDate } from "@infrawrench/ui";

import { listLocalDeploys, type LocalDeployRun } from "../lib/deploy-history";

/**
 * The Deploy tab in local mode: what `infrawrench deploy` did on this machine.
 *
 * Deploying *from here* needs an org — a GitHub App to read the Infrafile at a
 * branch head, and a build host to build on. Locally the CLI is the thing that
 * deploys, because it already has what a local deploy needs: the working tree
 * on disk and your own Docker daemon. So this half is a record rather than a
 * console, and it exists because a local deploy previously left no trace the
 * app could show at all — the answer was "go read your terminal scrollback".
 *
 * Cloud mode renders the shared DeploymentsPanel instead.
 */
export function LocalDeploymentsPanel() {
  const [runs, setRuns] = useState<LocalDeployRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRuns(await listLocalDeploys());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    // The CLI writes this file from another process, so nothing can notify us.
    // A slow poll while the tab is open is enough: a deploy takes minutes, and
    // the tab stays mounted whether or not it is the visible one.
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <div className="flex flex-col h-full min-h-0 text-on-surface">
      <div className="p-4 border-b border-white/10 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-sm font-semibold">Deploy</h1>
          <button
            type="button"
            onClick={() => void load()}
            className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary"
          >
            Refresh
          </button>
        </div>
        <p className="text-xs text-on-surface-secondary">
          Local deploys run from the terminal. In your project&apos;s directory run{" "}
          <code>infrawrench deploy</code> — it reads the Infrafile at your repo root and builds with
          your own Docker daemon. Runs show up here.
        </p>
        <p className="text-xs text-on-surface-faint">
          Deploying from the app, deploy-on-push triggers and rollbacks need an organization —
          switch to one in the sidebar to get the full Deploy screen.
        </p>
        {error && (
          <p className="text-xs text-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {runs === null ? (
          <p className="p-4 text-xs text-on-surface-faint">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="p-4 text-xs text-on-surface-faint">
            Nothing deployed from this machine yet.
          </p>
        ) : (
          <table className="w-full text-xs">
            <caption className="sr-only">Deploys from this machine</caption>
            <thead className="text-[11px] uppercase tracking-wide text-on-surface-faint">
              <tr className="border-b border-white/10">
                <Th>When</Th>
                <Th>Env</Th>
                <Th>Project</Th>
                <Th>Commit</Th>
                <Th>Image</Th>
                <Th>Status</Th>
                <Th>Took</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  expanded={expanded === run.id}
                  onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: LocalDeployRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetail = run.notes.length > 0 || run.error !== null;
  return (
    <>
      <tr className="border-b border-white/5">
        <Td>{formatDate(run.startedAt)}</Td>
        <Td>{run.env || "—"}</Td>
        <Td>
          <span title={run.dir}>{run.repo ?? basename(run.dir)}</span>
        </Td>
        <Td>
          {run.gitSha ? (
            <span title={run.dirty ? "Built from a tree with uncommitted changes" : undefined}>
              {run.gitSha.slice(0, 7)}
              {run.dirty && <span className="text-warning"> ·dirty</span>}
            </span>
          ) : (
            "—"
          )}
        </Td>
        <Td>{run.image ?? "—"}</Td>
        <Td>
          <span
            className={
              run.status === "success"
                ? "text-success"
                : run.status === "failure"
                  ? "text-danger"
                  : "text-on-surface-secondary"
            }
          >
            {run.status}
          </span>
          {/* Which stage it died at is the first thing you want from a failure. */}
          {run.status !== "success" && run.stage && (
            <span className="text-on-surface-faint"> at {stageLabel(run.stage)}</span>
          )}
        </Td>
        <Td>{run.durationMs === null ? "—" : `${Math.round(run.durationMs / 1000)}s`}</Td>
        <Td>
          {hasDetail && (
            <button
              type="button"
              onClick={onToggle}
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-on-surface-secondary"
            >
              {expanded ? "Hide" : "Details"}
            </button>
          )}
        </Td>
      </tr>
      {expanded && hasDetail && (
        <tr className="border-b border-white/5">
          <td colSpan={8} className="px-3 py-2">
            <div className="space-y-2 bg-surface-overlay rounded p-2">
              <p className="text-[11px] text-on-surface-faint">{run.dir}</p>
              {run.error && (
                <pre className="whitespace-pre-wrap text-danger font-mono">{run.error}</pre>
              )}
              {run.notes.map((note, i) => (
                <div key={i} className="font-mono text-[11px]">
                  {note}
                </div>
              ))}
              {run.orgId && (
                <p className="text-[11px] text-on-surface-faint">
                  Also recorded in the organization&apos;s deploy history.
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Only a stage the runtime actually declares is shown as one — the field is a
 * plain string in the record, and printing an unknown value as "at <junk>"
 * would read as a stage that exists.
 */
function stageLabel(stage: string): string {
  return (DEPLOY_STAGES as readonly string[]).includes(stage) ? stage : "an earlier stage";
}

function basename(dir: string): string {
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th scope="col" className="text-left font-normal px-3 py-1.5">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-1.5 align-top">{children}</td>;
}
