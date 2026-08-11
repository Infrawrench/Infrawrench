import { useCallback, useEffect, useRef, useState } from "react";
import {
  statusPageUrl,
  type StatusPage,
  type StatusPageComponentInput,
} from "@infrawrench/client-core";
import { StatusPageEditorModal } from "./StatusPageEditorModal.js";
import type { StatusPagesClient } from "./types.js";

export interface StatusPagesPanelProps {
  client: StatusPagesClient;
  /** Open a probe's detail, when the host has somewhere to send the user. */
  onOpenProbes?: (() => void) | undefined;
}

/**
 * "Status pages" section of the Probes panel: which of the org's synthetic
 * probes are published to the public, and at what URL.
 *
 * It sits under the probe list rather than on a tab of its own for the reason
 * Potential savings sits under Costs — publishing monitoring is a decision you
 * make while looking at the monitoring, and a separate tab makes people go
 * looking for it.
 *
 * The panel's job beyond CRUD is to make the *exposure* legible: whether a page
 * is live, exactly what URL it is live at, and a one-click way to revoke that
 * URL. Everything published is a probe the org already runs, so the risk here
 * is never "what does this measure" — it is "who can see it".
 */
export function StatusPagesPanel({ client, onOpenProbes }: StatusPagesPanelProps) {
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [probes, setProbes] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ page: StatusPage | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Bumped per request so a slow response can't overwrite a later refresh.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const [nextPages, nextProbes] = await Promise.all([
        client.listStatusPages(),
        // The probe list only feeds the editor's picker; failing it should not
        // hide pages that already exist.
        client.listProbes().catch(() => []),
      ]);
      if (seq !== requestSeq.current) return;
      setPages(nextPages);
      setProbes(nextProbes);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (input: {
    title: string;
    description: string | null;
    supportUrl: string | null;
    showHistory: boolean;
    showUptime: boolean;
    components: StatusPageComponentInput[];
  }) => {
    const target = editing?.page;
    if (target) await client.updateStatusPage(target.id, input);
    else await client.createStatusPage(input);
    setEditing(null);
    await refresh();
  };

  const togglePublished = async (page: StatusPage) => {
    if (
      !page.published &&
      !window.confirm(
        `Publish "${page.title}"? Anyone with its link will be able to see the state of its ` +
          `${page.components.length} component${page.components.length === 1 ? "" : "s"}, without signing in.`,
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.updateStatusPage(page.id, { published: !page.published });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const rotate = async (page: StatusPage) => {
    if (
      !window.confirm(
        `Issue a new link for "${page.title}"? The current link stops working immediately, ` +
          `and anyone who needs access will have to be sent the new one.`,
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.rotateSlug(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (page: StatusPage) => {
    if (!window.confirm(`Delete "${page.title}"? Its link stops working. The probes are kept.`)) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.deleteStatusPage(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (page: StatusPage) => {
    const url = statusPageUrl(client.appOrigin, page.slug);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(page.id);
      window.setTimeout(() => setCopiedId(null), 2_000);
    } catch {
      // Clipboard access can be denied; the URL is on screen either way.
      setError("Couldn't copy — select the link and copy it manually.");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">Status pages</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            Publish the probes above at a public link — the monitoring you already run, pointed at
            your users. Nothing is reachable until you publish it.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ page: null })}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          New page
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            Retry
          </button>
        </div>
      )}
      {pages === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          Loading status pages…
        </p>
      )}
      {pages !== null && pages.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          No status pages yet.{" "}
          {probes.length === 0 ? (
            <>
              Create a probe first — a status page publishes probes, so there is nothing to show
              until at least one exists.
              {onOpenProbes && (
                <>
                  {" "}
                  <button type="button" onClick={onOpenProbes} className="underline">
                    Add a probe
                  </button>
                </>
              )}
            </>
          ) : (
            <>A page picks from your {probes.length} probes and gives them public names.</>
          )}
        </p>
      )}

      {pages?.map((page) => {
        const url = statusPageUrl(client.appOrigin, page.slug);
        const busy = busyId === page.id;
        return (
          <div key={page.id} className="flex flex-col gap-2 rounded-xl border border-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-medium text-on-surface">
                  {page.title}
                  {page.published ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-success">
                      Live
                    </span>
                  ) : (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-faint">
                      Draft
                    </span>
                  )}
                </h3>
                <p className="mt-1 text-xs text-on-surface-tertiary">
                  {page.components.length} component{page.components.length === 1 ? "" : "s"}
                  {page.components.some((c) => !c.probeEnabled) && (
                    <span className="ml-2 text-warning">
                      Some probes are paused — those show as “No data”.
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void togglePublished(page)}
                disabled={busy}
                className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
              >
                {page.published ? "Unpublish" : "Publish"}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <code className="truncate rounded-lg border border-border bg-surface-raised px-2 py-1 text-on-surface-secondary">
                {url}
              </code>
              <button
                type="button"
                onClick={() => void copyLink(page)}
                className="text-on-surface-tertiary underline hover:text-on-surface"
              >
                {copiedId === page.id ? "Copied" : "Copy"}
              </button>
              {page.published && (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-on-surface-tertiary underline hover:text-on-surface"
                >
                  Open
                </a>
              )}
            </div>
            <p className="text-xs text-on-surface-faint">
              The link is the only thing protecting this page. Anyone who has it can read it.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing({ page })}
                disabled={busy}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void rotate(page)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
              >
                New link
              </button>
              <button
                type="button"
                onClick={() => void remove(page)}
                disabled={busy}
                className="ml-auto rounded-lg px-3 py-1.5 text-sm text-on-surface-tertiary hover:text-danger disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      {editing && (
        <StatusPageEditorModal
          page={editing.page}
          probes={probes}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </section>
  );
}
