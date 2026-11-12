import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import type { CiSchedules } from "@infrawrench/client-core";
import type { CiClient } from "./types.js";

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Each repository's pipelines with `on.schedule`, as last read from its
 * default branch, and when each runs next. Read-only: a schedule is the
 * pipeline file's, and a push to the default branch changing it is read
 * again at once.
 */
export function CiSchedulesCard({ client }: { client: CiClient }) {
  const gt = useGT();
  // A string, not `gt`, in the effect's deps (see CiCachesCard).
  const loadFailed = gt("Failed to load the schedules");
  const [schedules, setSchedules] = useState<CiSchedules | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .listSchedules()
      .then((s) => {
        if (cancelled) return;
        setSchedules(s);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : loadFailed));
    return () => {
      cancelled = true;
    };
  }, [client, loadFailed]);

  return (
    <section
      className="space-y-3 rounded border border-border bg-surface-raised p-4"
      aria-labelledby="ci-schedules"
    >
      <h3 id="ci-schedules" className="text-sm font-semibold text-on-surface">
        {gt("Schedules")}
      </h3>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : schedules === null ? (
        <p role="status" className="text-xs text-on-surface-faint">
          {gt("Loading…")}
        </p>
      ) : schedules.schedules.length === 0 ? (
        <p className="text-xs text-on-surface-muted">
          {gt("No pipeline on a default branch has a schedule.")}
        </p>
      ) : (
        <div className="space-y-3">
          {schedules.schedules.map((repo) => (
            <div key={`${repo.installationId}/${repo.repoFullName}`}>
              <p className="text-xs font-medium text-on-surface-secondary">
                {gt("{repo} on {branch}", {
                  repo: repo.repoFullName,
                  branch: repo.defaultBranch,
                })}
                {repo.sha ? (
                  <code className="ml-1 font-mono text-on-surface-faint">
                    {repo.sha.slice(0, 7)}
                  </code>
                ) : null}
              </p>
              {repo.error ? (
                <p role="alert" className="text-xs text-danger">
                  {gt("The last read failed: {error}", { error: repo.error })}
                </p>
              ) : null}
              {repo.pipelines.length > 0 ? (
                <table className="mt-1 w-full text-xs">
                  <caption className="sr-only">
                    {gt("Scheduled pipelines of {repo}", { repo: repo.repoFullName })}
                  </caption>
                  <thead>
                    <tr className="text-left text-on-surface-faint">
                      <th scope="col" className="py-1">
                        {gt("Pipeline")}
                      </th>
                      <th scope="col">{gt("Cron (UTC)")}</th>
                      <th scope="col">{gt("Next run")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {repo.pipelines.map((p) => (
                      <tr key={p.file} className="border-t border-border align-top">
                        <td className="py-1.5 text-on-surface">
                          {p.name}
                          <span className="block font-mono text-[10px] text-on-surface-faint">
                            {p.file}
                          </span>
                        </td>
                        <td className="py-1.5 font-mono text-on-surface-muted">
                          {p.cron.map((c) => (
                            <span key={c} className="block">
                              {c}
                            </span>
                          ))}
                        </td>
                        <td className="py-1.5 tabular-nums text-on-surface-muted">
                          {p.nextRunAt ? formatWhen(p.nextRunAt) : gt("Never")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
